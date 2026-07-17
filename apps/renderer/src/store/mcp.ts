import type {
	FolderId,
	McpServerDescriptor,
	McpServerStatus,
	ProviderId,
} from "@zuse/contracts";
import { Effect, Stream } from "effect";
import { create } from "zustand";

import { formatError } from "../lib/format-error.ts";
import { getRpcClient } from "../lib/rpc-client.ts";

export interface McpScope {
	readonly projectId?: FolderId;
	readonly provider?: ProviderId;
}

/**
 * Renderer cache of the user's MCP server inventory + connection statuses.
 * `load()` is cache-only after the initial provider discovery, so the popover
 * can call it on open without repeatedly invoking native provider CLIs.
 * `refresh()` explicitly forces discovery and status probes.
 */
type State = {
	readonly servers: ReadonlyArray<McpServerDescriptor>;
	readonly statuses: ReadonlyMap<string, McpServerStatus>;
	readonly loaded: boolean;
	readonly refreshing: boolean;
	readonly error: string | null;
	/** Keys with an OAuth round-trip in flight (drives the Connect spinner). */
	readonly authenticating: ReadonlySet<string>;
	readonly load: (scope: McpScope) => Promise<void>;
	readonly refresh: (scope: McpScope) => Promise<void>;
	readonly setEnabled: (
		key: string,
		enabled: boolean,
		projectId?: FolderId,
	) => Promise<void>;
	readonly authenticate: (
		key: string,
		projectId?: FolderId,
		provider?: ProviderId,
	) => Promise<void>;
};

const statusMap = (
	statuses: ReadonlyArray<McpServerStatus>,
): Map<string, McpServerStatus> =>
	new Map(statuses.map((status) => [status.key, status]));

const openExternal = (url: string): void => {
	const bridge = window.zuse ?? window.memoize;
	if (bridge?.app?.openExternal) {
		bridge.app.openExternal(url);
		return;
	}
	window.open(url, "_blank", "noopener,noreferrer");
};

export const useMcpStore = create<State>((set, get) => ({
	servers: [],
	statuses: new Map(),
	loaded: false,
	refreshing: false,
	error: null,
	authenticating: new Set(),

	load: async (scope) => {
		try {
			const client = await getRpcClient();
			const result = await Effect.runPromise(
				client["mcp.list"]({
					projectId: scope.projectId,
					provider: scope.provider,
				}),
			);
			set({
				servers: result.servers,
				statuses: statusMap(result.statuses),
				loaded: true,
				error: null,
			});
		} catch (err) {
			// Keep the previous inventory visible; a transient RPC failure
			// shouldn't blank a working popover.
			set({ loaded: true, error: get().loaded ? null : formatError(err) });
		}
	},

	refresh: async (scope) => {
		set({ refreshing: true });
		try {
			const client = await getRpcClient();
			const result = await Effect.runPromise(
				client["mcp.refresh"]({
					projectId: scope.projectId,
					provider: scope.provider,
				}),
			);
			set({
				servers: result.servers,
				statuses: statusMap(result.statuses),
				refreshing: false,
				error: null,
			});
		} catch (err) {
			set({ refreshing: false, error: formatError(err) });
		}
	},

	setEnabled: async (key, enabled, projectId) => {
		// Optimistic: flip the descriptor immediately, reconcile on reload.
		set({
			servers: get().servers.map((server) =>
				server.key !== key
					? server
					: server.source === "codex" || server.source === "codex-app"
						? { ...server, enabledInConfig: enabled }
						: { ...server, disabledByZuse: !enabled },
			),
		});
		try {
			const client = await getRpcClient();
			await Effect.runPromise(
				client["mcp.setEnabled"]({ key, enabled, projectId }),
			);
			await get().load({ projectId });
		} catch (err) {
			set({ error: formatError(err) });
			await get().load({ projectId });
		}
	},

	authenticate: async (key, projectId, provider) => {
		set({ authenticating: new Set([...get().authenticating, key]) });
		try {
			const client = await getRpcClient();
			await Effect.runPromise(
				Stream.runForEach(
					client["mcp.authenticate"]({ key, projectId }),
					(event) =>
						Effect.sync(() => {
							if (event._tag === "browser-opened") openExternal(event.url);
							if (event._tag === "failed") set({ error: event.error });
						}),
				),
			);
		} catch (err) {
			set({ error: formatError(err) });
		} finally {
			const next = new Set(get().authenticating);
			next.delete(key);
			set({ authenticating: next });
			await get().refresh({ projectId, provider });
		}
	},
}));
