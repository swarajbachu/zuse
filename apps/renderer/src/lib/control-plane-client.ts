import {
	CloudWorkspaceOpError,
	RpcAccessDeniedError,
	type WorkspaceScope,
} from "@zuse/contracts";
import { Effect } from "effect";
import type { getCloudControlClient } from "./cloud-control-client.ts";
import { hostedAccountId, isHostedProduct } from "./hosted-connect.ts";
import {
	assertRendererAccountCurrent,
	rendererAccountSnapshot,
	subscribeRendererAccount,
} from "./renderer-account.ts";
import {
	assertRendererWorkspaceCurrent,
	rendererWorkspaceSnapshot,
} from "./renderer-workspace.ts";
import { getControlPlaneRpcClient, type MemoizeClient } from "./rpc-client.ts";

/** Single renderer boundary for API account and workspace lifecycle RPCs. */
const runScopedControlPlane = async <Client, Result>(
	getClient: (scope: WorkspaceScope) => Promise<Client>,
	effect: (client: Client) => Effect.Effect<Result, unknown>,
	options?: { readonly scope?: "account" },
): Promise<Result> => {
	const account = rendererAccountSnapshot();
	const workspace = rendererWorkspaceSnapshot();
	const client = await getClient(
		options?.scope === "account" ? { kind: "personal" } : workspace.scope,
	);
	assertRendererAccountCurrent(account);
	if (options?.scope !== "account") assertRendererWorkspaceCurrent(workspace);
	try {
		return await Effect.runPromise(effect(client));
	} finally {
		assertRendererAccountCurrent(account);
		if (options?.scope !== "account") assertRendererWorkspaceCurrent(workspace);
	}
};

export const runControlPlane = <Result>(
	effect: (client: MemoizeClient) => Effect.Effect<Result, unknown>,
	options?: { readonly scope?: "account" },
): Promise<Result> =>
	runScopedControlPlane(getControlPlaneRpcClient, effect, options);

export const runCloudControl = <Result>(
	effect: (
		client: Awaited<ReturnType<typeof getCloudControlClient>>,
	) => Effect.Effect<Result, unknown>,
	options?: { readonly scope?: "account" },
): Promise<Result> =>
	runScopedControlPlane(
		async (scope) =>
			(await import("./cloud-control-client.ts")).getCloudControlClient(scope),
		effect,
		options,
	);

export const controlPlaneClient = (): Promise<MemoizeClient> =>
	getControlPlaneRpcClient();

type SessionCacheEntry = {
	value?: Promise<unknown>;
	snapshot?: unknown;
	checkedAt?: number;
	pending?: Promise<unknown>;
	expiresAt?: number;
};

const sessionCache = new Map<string, SessionCacheEntry>();
subscribeRendererAccount(() => sessionCache.clear());
const cacheListeners = new Set<(key: string) => void>();

// Persist only explicitly opted-in, schema-validated display data.
export type ControlPlaneCacheOptions<Result> = {
	readonly refresh?: boolean;
	readonly maxAgeMs?: number;
	readonly decode?: (value: unknown) => Result;
	/** Account-level data (e.g. plugins) is shared across workspaces. */
	readonly scope?: "account";
};
let accountId: string | null = null;
export const setControlPlaneCacheAccount = (id: string | null): void => {
	accountId = id;
};
const cacheScope = () => {
	const subject = rendererAccountSnapshot().subject;
	return subject === undefined
		? isHostedProduct()
			? hostedAccountId()
			: accountId
		: subject;
};
const storageKey = (key: string, accountScoped = false) => {
	const workspace = rendererWorkspaceSnapshot();
	const scopedKey =
		accountScoped || workspace.scope.kind === "personal"
			? key
			: `${encodeURIComponent(workspace.key)}:${key}`;
	const scope = cacheScope();
	return scope === null
		? null
		: `zuse.control-plane.v1:${encodeURIComponent(scope)}:${scopedKey}`;
};
const entryKey = (key: string, accountScoped = false) =>
	JSON.stringify([
		cacheScope(),
		rendererAccountSnapshot().epoch,
		accountScoped ? null : rendererWorkspaceSnapshot().key,
		key,
	]);
const readEntry = <Result>(
	key: string,
	options?: ControlPlaneCacheOptions<Result>,
): SessionCacheEntry | undefined => {
	const accountScoped = options?.scope === "account";
	const memoryKey = entryKey(key, accountScoped);
	const existing = sessionCache.get(memoryKey);
	if (existing || !options?.decode) return existing;
	const storedKey = storageKey(key, accountScoped);
	if (storedKey === null) return undefined;
	try {
		const raw = window.localStorage.getItem(storedKey);
		if (raw === null) return undefined;
		const stored = JSON.parse(raw);
		const snapshot = options.decode(stored.value);
		const entry = {
			snapshot,
			value: Promise.resolve(snapshot),
			checkedAt: undefined,
		};
		sessionCache.set(memoryKey, entry);
		return entry;
	} catch {
		return undefined;
	}
};
export const peekControlPlaneCache = <Result>(
	key: string,
	decode: (value: unknown) => Result,
	scope?: "account",
): Result | undefined =>
	readEntry(key, { decode, ...(scope ? { scope } : {}) })?.snapshot as
		| Result
		| undefined;

export const subscribeControlPlaneSessionCache = (
	listener: (key: string) => void,
): (() => void) => {
	cacheListeners.add(listener);
	return () => {
		cacheListeners.delete(listener);
	};
};

/** Successful reads stay cached for the renderer session until explicitly refreshed
 * or cleared on account changes. Opted-in display snapshots persist across reloads
 * and revalidate in the background, at most once every five minutes per session.
 * Restored snapshots revalidate on their first read. Failed refreshes retain data.
 */
export const runCachedControlPlane = <Result>(
	key: string,
	effect: (
		client: Awaited<ReturnType<typeof getCloudControlClient>>,
	) => Effect.Effect<Result, unknown>,
	options?: ControlPlaneCacheOptions<Result>,
): Promise<Result> =>
	runCachedRead(
		key,
		() =>
			runCloudControl(
				effect,
				options?.scope === "account" ? { scope: "account" } : undefined,
			),
		options,
	);

/** The same session cache for any control-plane read (e.g. organizations). */
export const runCachedRead = <Result>(
	key: string,
	read: () => Promise<Result>,
	options?: ControlPlaneCacheOptions<Result>,
): Promise<Result> => {
	const account = rendererAccountSnapshot();
	const workspace = rendererWorkspaceSnapshot();
	const accountScoped = options?.scope === "account";
	const current = (value: Result): Result => {
		assertRendererAccountCurrent(account);
		if (!accountScoped) assertRendererWorkspaceCurrent(workspace);
		if (entryKey(key, accountScoped) !== memoryKey)
			throw new Error(
				"The connection account changed. Reconnect this environment.",
			);
		return value;
	};
	const memoryKey = entryKey(key, accountScoped);
	const persistedKey = options?.decode ? storageKey(key, accountScoped) : null;
	const previous = readEntry(key, options);
	// A refresh after a mutation must not join a read started before that write.
	const entry: SessionCacheEntry = options?.refresh
		? {
				value: previous?.value,
				snapshot: previous?.snapshot,
				checkedAt: previous?.checkedAt,
				expiresAt: previous?.expiresAt,
			}
		: (previous ?? {});
	const cached = entry.value as Promise<Result> | undefined;
	const stale =
		options?.decode &&
		(entry.checkedAt === undefined ||
			Date.now() - entry.checkedAt >= 5 * 60_000);
	const expired =
		options?.maxAgeMs !== undefined && (entry.expiresAt ?? 0) <= Date.now();
	if (!options?.refresh && cached && !stale && !expired)
		return cached.then(current);
	if (!entry.pending) {
		sessionCache.set(memoryKey, entry);
		const request = read().then(
			(value) => {
				current(value);
				if (
					sessionCache.get(memoryKey) === entry &&
					entryKey(key, accountScoped) === memoryKey
				) {
					const changed =
						!options?.decode ||
						JSON.stringify(entry.snapshot) !== JSON.stringify(value);
					if (changed) entry.snapshot = value;
					entry.checkedAt = Date.now();
					entry.expiresAt =
						Date.now() + (options?.maxAgeMs ?? Number.POSITIVE_INFINITY);
					entry.value = Promise.resolve(entry.snapshot);
					if (persistedKey !== null) {
						try {
							window.localStorage.setItem(
								persistedKey,
								JSON.stringify({ value: entry.snapshot }),
							);
						} catch {
							/* Best-effort cache. */
						}
					}
					entry.pending = undefined;
					if (changed) for (const listener of cacheListeners) listener(key);
				}
				return value;
			},
			(cause) => {
				if (
					sessionCache.get(memoryKey) === entry &&
					entryKey(key, accountScoped) === memoryKey
				) {
					entry.pending = undefined;
					entry.checkedAt = Date.now();
					if (
						cause instanceof RpcAccessDeniedError ||
						(cause instanceof CloudWorkspaceOpError &&
							cause.code === "not-allowed")
					) {
						invalidateControlPlaneCache(
							key,
							accountScoped ? "account" : undefined,
						);
					} else if (!entry.value) sessionCache.delete(memoryKey);
				}
				throw cause;
			},
		);
		entry.pending = request;
	}
	if (!options?.refresh && cached && !expired) {
		void entry.pending.catch(() => undefined);
		return cached.then(current);
	}
	return entry.pending as Promise<Result>;
};

/** Discard a display snapshot after a write, including its persisted copy. */
export const invalidateControlPlaneCache = (
	key: string,
	scope?: "account",
): void => {
	sessionCache.delete(entryKey(key, scope === "account"));
	const persistedKey = storageKey(key, scope === "account");
	if (persistedKey !== null) {
		try {
			window.localStorage.removeItem(persistedKey);
		} catch {
			/* Best-effort cache. */
		}
	}
};

export const clearControlPlaneSessionCache = (prefix?: string): void => {
	if (prefix === undefined) {
		sessionCache.clear();
		return;
	}
	for (const key of sessionCache.keys()) {
		if ((JSON.parse(key) as unknown[]).at(-1)?.toString().startsWith(prefix))
			sessionCache.delete(key);
	}
};
