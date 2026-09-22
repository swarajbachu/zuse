import { Effect } from "effect";

import { getControlPlaneRpcClient, type MemoizeClient } from "./rpc-client.ts";

/** Single renderer boundary for API account and workspace lifecycle RPCs. */
export const runControlPlane = async <Result>(
	effect: (client: MemoizeClient) => Effect.Effect<Result, unknown>,
): Promise<Result> => {
	const client = await getControlPlaneRpcClient();
	return Effect.runPromise(effect(client));
};

export const controlPlaneClient = (): Promise<MemoizeClient> =>
	getControlPlaneRpcClient();

type SessionCacheEntry = Readonly<{
	promise: Promise<unknown>;
	expiresAt: number;
}>;

const sessionCache = new Map<string, SessionCacheEntry>();

/**
 * App-lifetime cache for control-plane reads. Failed requests are evicted so a
 * later consumer can retry; successful values remain warm until an explicit
 * refresh or the renderer process exits.
 */
export const runCachedControlPlane = <Result>(
	key: string,
	effect: (client: MemoizeClient) => Effect.Effect<Result, unknown>,
	options?: { readonly refresh?: boolean; readonly maxAgeMs?: number },
): Promise<Result> => {
	if (!options?.refresh) {
		const cached = sessionCache.get(key);
		if (cached !== undefined && cached.expiresAt > Date.now()) {
			return cached.promise as Promise<Result>;
		}
	}

	const request = runControlPlane(effect).catch((cause) => {
		if (sessionCache.get(key)?.promise === request) sessionCache.delete(key);
		throw cause;
	});
	sessionCache.set(key, {
		promise: request,
		expiresAt:
			options?.maxAgeMs === undefined
				? Number.POSITIVE_INFINITY
				: Date.now() + options.maxAgeMs,
	});
	return request;
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
