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

/** Successful reads stay cached for the renderer session until explicitly refreshed
 * or cleared on account changes. Reads during a refresh retain the last value.
 */
export const runCachedControlPlane = <Result>(
	key: string,
	effect: (client: MemoizeClient) => Effect.Effect<Result, unknown>,
	options?: { readonly refresh?: boolean },
): Promise<Result> => {
	const previous = sessionCache.get(key);
	// A refresh after a mutation must not join a read started before that write.
	const entry: SessionCacheEntry = options?.refresh
		? { value: previous?.value }
		: (previous ?? {});
	const cached = entry.value as Promise<Result> | undefined;
	if (!options?.refresh && cached) {
		return cached;
	}
	if (!entry.pending) {
		sessionCache.set(key, entry);
		const request = runControlPlane(effect).then(
			(value) => {
				if (sessionCache.get(key) === entry) {
					entry.value = Promise.resolve(value);
					entry.pending = undefined;
					for (const listener of cacheListeners) listener(key);
				}
				return value;
			},
			(cause) => {
				if (sessionCache.get(key) === entry) {
					entry.pending = undefined;
					if (!entry.value) sessionCache.delete(key);
				}
				throw cause;
			},
		);
		entry.pending = request;
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
