import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

import { ProviderId } from "./agent.ts";
import { FolderId } from "./ids.ts";

// ---------------------------------------------------------------------------
// User MCP servers. Zuse keeps NO registry of its own: it reconciles native
// config files with provider-reported servers, plugins, and connected apps.
// Config sources include `~/.claude.json` (user + per-project "local"
// scopes), the project `.mcp.json` (project scope), and
// `~/.codex/config.toml [mcp_servers.*]`. Zuse shows the reconciled inventory,
// injects only compatible configured servers into agent sessions, and stores
// only enable/disable overrides (keys, never server definitions) in settings.
// See specs/self-orchestration/decisions/0032-mcp-connector-passthrough.md.
// ---------------------------------------------------------------------------

/**
 * Where a server definition came from. The configured Claude scopes mirror
 * native precedence (local > project > user); plugin/app sources are native
 * provider-managed entries. `codex` is the user's config entry and
 * `codex-app` covers provider-managed apps. `builtin` covers Zuse's
 * in-process servers, which are always injected and shown as connected.
 */
export const McpServerSource = Schema.Literals([
	"claude-user",
	"claude-project",
	"claude-local",
	"claude-plugin",
	"claude-app",
	"codex",
	"codex-app",
	"builtin",
]);
export type McpServerSource = typeof McpServerSource.Type;

export const McpTransport = Schema.Literals(["stdio", "http", "sse"]);
export type McpTransport = typeof McpTransport.Type;

export const McpServerKind = Schema.Literals([
	"configured",
	"builtin",
	"provider",
	"app-group",
	"app",
]);
export type McpServerKind = typeof McpServerKind.Type;

export const McpAuthenticationAction = Schema.Literals([
	"native-oauth",
	"open-url",
]);
export type McpAuthenticationAction = typeof McpAuthenticationAction.Type;

/**
 * One configured or provider-reported inventory entry. Env/header *values*
 * never cross the wire (they may hold secrets) — only variable names, so the
 * UI can surface unmet requirements like "env var FOO is not set".
 */
export const McpServerDescriptor = Schema.Struct({
	/**
	 * Stable identity across refreshes: `<family>:<name>` where family is
	 * `claude` | `codex` | `builtin` (Claude scopes collapse to one effective
	 * server per name, `source` records the winning scope). Also the key used
	 * by the enable/disable overrides in settings.
	 */
	key: Schema.String,
	name: Schema.String,
	source: McpServerSource,
	kind: McpServerKind,
	/** Parent aggregate for virtual connector rows. */
	parentKey: Schema.NullOr(Schema.String),
	/** Providers whose sessions can actually call this entry. */
	availableProviders: Schema.Array(ProviderId),
	transport: Schema.NullOr(McpTransport),
	/** stdio only. */
	command: Schema.NullOr(Schema.String),
	args: Schema.Array(Schema.String),
	/** http/sse only. */
	url: Schema.NullOr(Schema.String),
	/** Names of env vars / headers the config references (values withheld). */
	envVarNames: Schema.Array(Schema.String),
	/** `enabled = false` in the native config itself (codex supports this). */
	enabledInConfig: Schema.Boolean,
	/** Effective Zuse-side toggle (global ∪ per-repository overrides). */
	disabledByZuse: Schema.Boolean,
	/** False for provider-managed entries with no safe native mutation API. */
	toggleSupported: Schema.Boolean,
	/** Authentication action offered by the UI, if any. */
	authenticationAction: Schema.NullOr(McpAuthenticationAction),
	/** Provider-owned connect/manage URL; never contains held credentials. */
	manageUrl: Schema.NullOr(Schema.String),
});
export type McpServerDescriptor = typeof McpServerDescriptor.Type;

export const McpServerState = Schema.Literals([
	"connected",
	"connecting",
	"error",
	"needs-auth",
	"disabled",
]);
export type McpServerState = typeof McpServerState.Type;

/**
 * A prerequisite the server needs before it can connect, shown under the
 * row in the popover/settings ("command not found: uvx", "env var
 * LINEAR_API_KEY is not set", "authentication required").
 */
export const McpRequirement = Schema.Struct({
	kind: Schema.Literals(["command", "env", "auth"]),
	detail: Schema.String,
	satisfied: Schema.Boolean,
});
export type McpRequirement = typeof McpRequirement.Type;

export const McpServerStatus = Schema.Struct({
	key: Schema.String,
	name: Schema.String,
	source: McpServerSource,
	state: McpServerState,
	toolCount: Schema.NullOr(Schema.Number),
	toolNames: Schema.Array(Schema.String),
	/** Human-readable failure reason when `state === "error"`. */
	error: Schema.NullOr(Schema.String),
	/** How the server authenticates when `state === "needs-auth"`. */
	authMethod: Schema.NullOr(Schema.Literals(["oauth", "token"])),
	requirements: Schema.Array(McpRequirement),
	/** Epoch ms of the probe that produced this status; 0 = never probed. */
	checkedAt: Schema.Number,
});
export type McpServerStatus = typeof McpServerStatus.Type;

export class McpConfigError extends Schema.TaggedErrorClass<McpConfigError>()(
	"McpConfigError",
	{ key: Schema.NullOr(Schema.String), reason: Schema.String },
) {}

/**
 * Filter for list/refresh. `projectId` resolves the project-scoped Claude
 * configs (`.mcp.json` + `~/.claude.json#projects[cwd]`) and applies
 * per-repository disable overrides; absent means user-level scopes only.
 * `provider` narrows to entries usable by that provider's sessions; absent
 * means the complete cross-provider inventory.
 */
const McpScopePayload = Schema.Struct({
	projectId: Schema.optional(FolderId),
	provider: Schema.optional(ProviderId),
});

/**
 * Unified inventory + last-known statuses. Returns the cached snapshot after
 * one initial provider discovery; `mcp.refresh` explicitly forces a new
 * discovery and status probe.
 */
export const McpListRpc = Rpc.make("mcp.list", {
	payload: McpScopePayload,
	success: Schema.Struct({
		servers: Schema.Array(McpServerDescriptor),
		statuses: Schema.Array(McpServerStatus),
	}),
	error: McpConfigError,
});

export const McpRefreshRpc = Rpc.make("mcp.refresh", {
	payload: McpScopePayload,
	success: Schema.Struct({
		servers: Schema.Array(McpServerDescriptor),
		statuses: Schema.Array(McpServerStatus),
	}),
	error: McpConfigError,
});

/**
 * Zuse-side enable/disable override (never rewrites claude configs; for
 * codex-source servers it writes the native `enabled` flag, which is the
 * documented Codex semantics). Omitted `projectId` toggles globally.
 */
export const McpSetEnabledRpc = Rpc.make("mcp.setEnabled", {
	payload: Schema.Struct({
		key: Schema.String,
		enabled: Schema.Boolean,
		projectId: Schema.optional(FolderId),
	}),
	success: Schema.Void,
	error: McpConfigError,
});

export const McpAuthenticateEvent = Schema.Union([
	Schema.TaggedStruct("browser-opened", { url: Schema.String }),
	Schema.TaggedStruct("completed", {}),
	Schema.TaggedStruct("failed", { error: Schema.String }),
]);
export type McpAuthenticateEvent = typeof McpAuthenticateEvent.Type;

/**
 * Runs the OAuth flow for a `needs-auth` server: discovery + dynamic client
 * registration + PKCE with a loopback redirect for claude-source servers,
 * codex-native `mcpServer/oauth/login` for codex-source ones. Emits
 * progress until the browser round-trip completes.
 */
export const McpAuthenticateRpc = Rpc.make("mcp.authenticate", {
	payload: Schema.Struct({
		key: Schema.String,
		projectId: Schema.optional(FolderId),
	}),
	success: McpAuthenticateEvent,
	error: McpConfigError,
	stream: true,
});
