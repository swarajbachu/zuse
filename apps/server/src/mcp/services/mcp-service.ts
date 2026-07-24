import type { ResolvedMcpServer } from "@zuse/agents/user-mcp/types";

import type {
	FolderId,
	McpAuthenticateEvent,
	McpConfigError,
	McpServerDescriptor,
	McpServerStatus,
	ProviderId,
} from "@zuse/contracts";
import { Context, type Effect, type Stream } from "effect";

export interface McpScope {
	readonly projectId?: FolderId | undefined;
	readonly provider?: ProviderId | undefined;
}

/**
 * Unified inventory over native MCP configs, provider-reported servers,
 * plugins, connected apps, and Zuse's builtins, with live connection status.
 * Provider definitions are never persisted by Zuse — only enable/disable
 * overrides (settings + repository settings) and OAuth tokens (keychain).
 */
export interface McpServiceShape {
	/** Inventory + cached statuses (bootstraps provider discovery once). */
	readonly list: (scope: McpScope) => Effect.Effect<
		{
			readonly servers: ReadonlyArray<McpServerDescriptor>;
			readonly statuses: ReadonlyArray<McpServerStatus>;
		},
		McpConfigError
	>;
	/** Force provider discovery and a status probe for every enabled server. */
	readonly refresh: (scope: McpScope) => Effect.Effect<
		{
			readonly servers: ReadonlyArray<McpServerDescriptor>;
			readonly statuses: ReadonlyArray<McpServerStatus>;
		},
		McpConfigError
	>;
	readonly setEnabled: (
		key: string,
		enabled: boolean,
		projectId: FolderId | undefined,
	) => Effect.Effect<void, McpConfigError>;
	/** OAuth round-trip for a `needs-auth` server; emits progress events. */
	readonly authenticate: (
		key: string,
		projectId: FolderId | undefined,
	) => Stream.Stream<McpAuthenticateEvent, McpConfigError>;
	/**
	 * Enabled claude-source servers for a session working directory, env
	 * expanded and stored OAuth tokens injected as Authorization headers.
	 * Never fails — a config/keychain problem yields [] so session start is
	 * unaffected.
	 */
	readonly resolveForClaudeSession: (
		cwd: string,
	) => Effect.Effect<ReadonlyArray<ResolvedMcpServer>>;
	/**
	 * Enabled native servers for a bundled local SDK session. Both supported
	 * native config sources are accepted because this runtime has no CLI-owned
	 * config of its own.
	 */
	readonly resolveForCursorSession: (
		cwd: string,
	) => Effect.Effect<ReadonlyArray<ResolvedMcpServer>>;
}

export class McpService extends Context.Service<McpService, McpServiceShape>()(
	"memoize/McpService",
) {}
