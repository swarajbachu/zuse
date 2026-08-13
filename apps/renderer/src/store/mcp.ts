import type {
	FolderId,
	McpServerDescriptor,
	McpServerStatus,
	ProviderId,
} from "@zuse/contracts";
import { CommandId, EnvironmentId } from "@zuse/contracts";

import { formatError } from "../lib/format-error.ts";
import { dispatchEnvironmentShellCommand } from "../lib/environment-shell-client-bus.ts";
import { runtimeOperationClient } from "../lib/runtime-operation-client.ts";
import { runStreamOperation } from "../lib/stream-operation.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { useEnvironmentCatalogStore } from "./environment-catalog.ts";

const activeEnvironmentId = (): EnvironmentId =>
	EnvironmentId.make(useEnvironmentCatalogStore.getState().activeEnvironmentId);

const mcpCommand = async <Payload, Result>(
	kind: string,
	payload: Payload,
): Promise<Result> => {
	const receipt = await dispatchEnvironmentShellCommand<Payload, Result>({
		environmentId: activeEnvironmentId(),
		kind,
		commandId: CommandId.make(`mcp:${crypto.randomUUID()}`),
		payload,
	});
	return receipt.result;
};

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
			const environmentId = activeEnvironmentId();
			const result = await mcpCommand<
				{
					readonly projectId: FolderId | undefined;
					readonly provider: ProviderId | undefined;
				},
				{
					readonly servers: ReadonlyArray<McpServerDescriptor>;
					readonly statuses: ReadonlyArray<McpServerStatus>;
				}
			>("mcp.list", {
				projectId: scope.projectId,
				provider: scope.provider,
			});
			if (environmentId !== activeEnvironmentId()) return;
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
			const environmentId = activeEnvironmentId();
			const result = await mcpCommand<
				{
					readonly projectId: FolderId | undefined;
					readonly provider: ProviderId | undefined;
				},
				{
					readonly servers: ReadonlyArray<McpServerDescriptor>;
					readonly statuses: ReadonlyArray<McpServerStatus>;
				}
			>("mcp.refresh", {
				projectId: scope.projectId,
				provider: scope.provider,
			});
			if (environmentId !== activeEnvironmentId()) return;
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
			await mcpCommand("mcp.setEnabled", { key, enabled, projectId });
			await get().load({ projectId });
		} catch (err) {
			set({ error: formatError(err) });
			await get().load({ projectId });
		}
	},

	authenticate: async (key, projectId, provider) => {
		set({ authenticating: new Set([...get().authenticating, key]) });
		try {
			const client = await runtimeOperationClient(activeEnvironmentId());
			await runStreamOperation(
				client["mcp.authenticate"]({ key, projectId }),
				(event) => {
					if (event._tag === "browser-opened") openExternal(event.url);
					if (event._tag === "failed") set({ error: event.error });
				},
			).done;
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
