import {
	PLUGIN_CALLBACK_PORTS,
	type PluginRequest,
	type PluginReturnTo,
	PluginSnapshot,
} from "@zuse/contracts";
import { Effect, Schema } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	peekControlPlaneCache,
	runCachedRead,
	subscribeControlPlaneSessionCache,
} from "./control-plane-client.ts";
import { getControlPlaneRpcClient } from "./rpc-client.ts";

export async function pluginRequest(input: PluginRequest) {
	const scope = input.tenantId?.startsWith("organization:")
		? {
				kind: "organization" as const,
				organizationId: input.tenantId.slice(13),
			}
		: { kind: "personal" as const };
	const client = await getControlPlaneRpcClient(scope);
	return Effect.runPromise(client["plugins.request"](input));
}

/**
 * Where the provider callback should hand the ticket back. Desktop returns to
 * its sign-in loopback so the browser never has to open the web app.
 */
export async function pluginReturnTo(): Promise<PluginReturnTo> {
	const port = await window.zuse?.plugins?.callbackPort().catch(() => null);
	const allowed = PLUGIN_CALLBACK_PORTS.find((value) => value === port);
	return allowed === undefined
		? { kind: "web" }
		: { kind: "desktop", port: allowed };
}

/**
 * Connections changed (an OAuth return, a toggle). Refreshes the shared
 * snapshot once; every view subscribed to the cache updates from it.
 */
export const notifyPluginsChanged = (tenantId?: string) => {
	void loadPluginSnapshot(tenantId, true).catch(() => undefined);
};

const decodeSnapshot = Schema.decodeUnknownSync(PluginSnapshot);
const snapshotKey = (tenantId?: string) =>
	`plugins:list:${tenantId ?? "personal"}`;

/**
 * The catalog and connections, from the shared account-scoped cache: shown
 * instantly (also after a restart) and revalidated in the background. Pass
 * `refresh` after a change so every view picks it up.
 */
export const loadPluginSnapshot = (
	tenantId?: string,
	refresh = false,
): Promise<PluginSnapshot> =>
	runCachedRead(
		snapshotKey(tenantId),
		async () => {
			const result = await pluginRequest({ action: "list", tenantId });
			if (result.kind !== "snapshot")
				throw new Error("Unexpected plugin response");
			return result;
		},
		{ decode: decodeSnapshot, scope: "account", refresh },
	);

export const peekPluginSnapshot = (tenantId?: string) =>
	peekControlPlaneCache(snapshotKey(tenantId), decodeSnapshot, "account");

/** Live plugin snapshot for a tenant; null until the first load, never while signed out. */
export function usePluginSnapshot(
	account: string | null,
	tenantId?: string,
): {
	readonly snapshot: PluginSnapshot | null;
	readonly failed: boolean;
	readonly refresh: () => Promise<void>;
} {
	const [result, setResult] = useState<{
		account: string | null;
		tenantId: string | undefined;
		snapshot: PluginSnapshot | null;
	}>(() => ({
		account,
		tenantId,
		snapshot: account === null ? null : (peekPluginSnapshot(tenantId) ?? null),
	}));
	const current = useRef({ account, tenantId });
	current.current = { account, tenantId };
	const setSnapshot = useCallback(
		(snapshot: PluginSnapshot | null) => {
			if (
				current.current.account === account &&
				current.current.tenantId === tenantId
			)
				setResult({ account, tenantId, snapshot });
		},
		[account, tenantId],
	);
	const [failed, setFailed] = useState(false);
	const load = useCallback(
		async (refresh: boolean) => {
			if (account === null) return;
			try {
				const snapshot = await loadPluginSnapshot(tenantId, refresh);
				if (
					current.current.account !== account ||
					current.current.tenantId !== tenantId
				)
					return;
				setSnapshot(snapshot);
				setFailed(false);
			} catch {
				if (
					current.current.account === account &&
					current.current.tenantId === tenantId
				)
					setFailed(true);
			}
		},
		[account, tenantId, setSnapshot],
	);
	useEffect(() => {
		setSnapshot(
			account === null ? null : (peekPluginSnapshot(tenantId) ?? null),
		);
		if (account === null) return;
		void load(false);
		const key = snapshotKey(tenantId);
		const unsubscribe = subscribeControlPlaneSessionCache((changed) => {
			if (changed === key) setSnapshot(peekPluginSnapshot(tenantId) ?? null);
		});
		return unsubscribe;
	}, [account, tenantId, load, setSnapshot]);
	const refresh = useCallback(() => load(true), [load]);
	return {
		snapshot:
			account !== null &&
			result.account === account &&
			result.tenantId === tenantId
				? result.snapshot
				: null,
		failed,
		refresh,
	};
}
