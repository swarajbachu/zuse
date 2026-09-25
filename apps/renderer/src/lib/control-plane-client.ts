import { Effect } from "effect";

import { getControlPlaneRpcClient, type MemoizeClient } from "./rpc-client.ts";

/** Single renderer boundary for API account and workspace lifecycle RPCs. */
export const runControlPlane = async <Result>(
	effect: (client: MemoizeClient) => Effect.Effect<Result, unknown>,
): Promise<Result> => {
	const client = await getControlPlaneRpcClient();
	return Effect.runPromise(effect(client));
};

type SessionCacheEntry = {
	value?: Promise<unknown>;
	pending?: Promise<unknown>;
	expiresAt: number;
};

const sessionCache = new Map<string, SessionCacheEntry>();
const cacheListeners = new Set<(key: string) => void>();

export const subscribeControlPlaneSessionCache = (
	listener: (key: string) => void,
): (() => void) => {
	cacheListeners.add(listener);
	return () => {
		cacheListeners.delete(listener);
	};
};

/** Shared reads deduplicate background requests. Opt-in stale
 * reads return the last successful value while revalidating in the background.
 * Freshness starts at completion, so slow requests never expire in flight.
 */
export const runCachedControlPlane = <Result>(
	key: string,
	effect: (client: MemoizeClient) => Effect.Effect<Result, unknown>,
	options?: {
		readonly refresh?: boolean;
		readonly maxAgeMs?: number;
		readonly staleWhileRevalidate?: boolean;
	},
): Promise<Result> => {
	const previous = sessionCache.get(key);
	// A refresh after a mutation must not join a read started before that write.
	const entry: SessionCacheEntry = options?.refresh
		? { value: previous?.value, expiresAt: 0 }
		: (previous ?? { expiresAt: 0 });
	const cached = entry.value as Promise<Result> | undefined;
	if (!options?.refresh && cached && entry.expiresAt > Date.now()) {
		return cached;
	}
	if (!entry.pending) {
		sessionCache.set(key, entry);
		const request = runControlPlane(effect).then(
			(value) => {
				if (sessionCache.get(key) === entry) {
					entry.value = Promise.resolve(value);
					entry.pending = undefined;
					entry.expiresAt = Date.now() + (options?.maxAgeMs ?? Infinity);
					for (const listener of cacheListeners) listener(key);
				}
				return value;
			},
			(cause) => {
				if (sessionCache.get(key) === entry) {
					entry.pending = undefined;
					if (entry.value) {
						// Preserve usable data through outages and avoid retry storms.
						entry.expiresAt = Date.now() + 5_000;
					} else sessionCache.delete(key);
				}
				throw cause;
			},
		);
		entry.pending = request;
	}
	if (!options?.refresh && cached && options?.staleWhileRevalidate) {
		void entry.pending.catch(() => {});
		return cached;
	}
	return entry.pending as Promise<Result>;
};

export const clearControlPlaneSessionCache = (prefix?: string): void => {
	if (prefix === undefined) {
		sessionCache.clear();
		return;
	}
	for (const key of sessionCache.keys()) {
		if (key.startsWith(prefix)) sessionCache.delete(key);
	}
};
