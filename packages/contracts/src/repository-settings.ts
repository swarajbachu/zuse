import { Effect, Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

import { ProviderId, RuntimeMode } from "./agent.ts";
import { FolderId } from "./ids.ts";

/**
 * Summary of the repository-provided configuration Zuse holds back while a
 * project is untrusted. Server-side only — computed by the repository
 * settings service so the renderer can show the user exactly what would
 * run (or be applied) once trust is granted. Never persisted.
 */
export const GatedRepositoryConfig = Schema.Struct({
	/** `[scripts].setup` from `.zuse/settings.*`, when the repo ships one. */
	setupScript: Schema.NullOr(Schema.String),
	/** `[scripts].run` from `.zuse/settings.*`, when the repo ships one. */
	runScript: Schema.NullOr(Schema.String),
	/** `[scripts].archive` from `.zuse/settings.*`, when the repo ships one. */
	archiveCleanupScript: Schema.NullOr(Schema.String),
	/** `[scripts].auto_run_after_setup` from `.zuse/settings.*`. */
	autoRunAfterSetup: Schema.Boolean,
	/** Names only — values stay server-side even in the gated summary. */
	environmentVariableNames: Schema.Array(Schema.String),
	/** Server names found in the repo's `.mcp.json`. */
	mcpServerNames: Schema.Array(Schema.String),
	/**
	 * True when the repo file also overrides non-script fields (provider,
	 * model, runtime mode, worktree options, include globs, disabled MCP
	 * servers). Those are gated too; they are summarized as one flag
	 * instead of leaking the values.
	 */
	otherOverrides: Schema.Boolean,
});
export type GatedRepositoryConfig = typeof GatedRepositoryConfig.Type;

/**
 * Per-repository overrides on top of the global Settings. A `null` field
 * means "fall through to global default"; the renderer is responsible for
 * collapsing this layer at read-time. Persisted in `.zuse/settings.json`
 * under the repository root.
 */
export class RepositorySettings extends Schema.Class<RepositorySettings>(
	"RepositorySettings",
)({
	projectId: FolderId,
	defaultProviderId: Schema.NullOr(ProviderId),
	defaultModel: Schema.NullOr(Schema.String),
	defaultRuntimeMode: Schema.NullOr(RuntimeMode),
	/**
	 * If true, every new chat created in this repo pre-creates a worktree at
	 * session start. The composer's workspace picker still appears (so the
	 * user can flip back to "Current checkout" before the first message).
	 */
	autoCreateWorktree: Schema.Boolean,
	/**
	 * Optional override for the worktree base dir. `null` means the global
	 * default: `~/.zuse/<repo-name>-<projectId-short>/`.
	 */
	worktreeBaseDir: Schema.NullOr(Schema.String),
	/**
	 * Optional user-authored shell body to run before archiving a chat that is
	 * bound to a worktree. Empty/null means archive without cleanup.
	 */
	archiveCleanupScript: Schema.NullOr(Schema.String),
	setupScript: Schema.NullOr(Schema.String),
	runScript: Schema.NullOr(Schema.String),
	autoRunAfterSetup: Schema.Boolean,
	environmentVariables: Schema.Record(Schema.String, Schema.String),
	/** Non-secret overrides applied only while preparing or running in cloud. */
	cloudEnvironmentVariables: Schema.Record(Schema.String, Schema.String).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed({})),
	),
	/**
	 * Newline-separated gitignore-style patterns for local files that should be
	 * linked into every Zuse worktree from the main checkout. Empty means "use
	 * Zuse's built-in env-file discovery fallback".
	 */
	fileIncludeGlobs: Schema.String,
	/**
	 * User MCP servers switched off for this repository, by descriptor key
	 * (`claude:<name>` / `codex:<name>`). Unioned with the global
	 * `mcpDisabledServers` list at read-time.
	 */
	mcpDisabledServers: Schema.Array(Schema.String),
	/**
	 * Whether the user has granted this project permission to apply
	 * repository-provided configuration. Lives server-side (a column on the
	 * `projects` row) — never inside `.zuse/settings.*`, which the repo
	 * itself controls and could use to self-trust. When false, every field
	 * above is reported as its empty default and `gatedConfig` describes
	 * what is being held back.
	 */
	trusted: Schema.Boolean,
	/**
	 * Non-null when the project is untrusted AND the repository ships
	 * configuration Zuse is holding back. Drives the trust banner; `null`
	 * for trusted projects and for untrusted projects with nothing to gate.
	 */
	gatedConfig: Schema.NullOr(GatedRepositoryConfig),
}) {}

/**
 * Patch shape for `repository.settings.update`. Every field is optional;
 * absent means "leave unchanged". Use `null` explicitly to clear an
 * override back to the global default.
 */
export const RepositorySettingsPatch = Schema.Struct({
	defaultProviderId: Schema.optional(Schema.NullOr(ProviderId)),
	defaultModel: Schema.optional(Schema.NullOr(Schema.String)),
	defaultRuntimeMode: Schema.optional(Schema.NullOr(RuntimeMode)),
	autoCreateWorktree: Schema.optional(Schema.Boolean),
	worktreeBaseDir: Schema.optional(Schema.NullOr(Schema.String)),
	archiveCleanupScript: Schema.optional(Schema.NullOr(Schema.String)),
	setupScript: Schema.optional(Schema.NullOr(Schema.String)),
	runScript: Schema.optional(Schema.NullOr(Schema.String)),
	autoRunAfterSetup: Schema.optional(Schema.Boolean),
	environmentVariables: Schema.optional(
		Schema.Record(Schema.String, Schema.String),
	),
	cloudEnvironmentVariables: Schema.optional(
		Schema.Record(Schema.String, Schema.String),
	),
	fileIncludeGlobs: Schema.optional(Schema.String),
	mcpDisabledServers: Schema.optional(Schema.Array(Schema.String)),
	/**
	 * Grant or revoke trust. Server-side state only — this field is never
	 * written into `.zuse/settings.*` (the repo must not be able to flip it
	 * by editing its own config file).
	 */
	trusted: Schema.optional(Schema.Boolean),
});
export type RepositorySettingsPatch = typeof RepositorySettingsPatch.Type;

/**
 * On-disk `.zuse/settings.json` shape. It intentionally omits `projectId`
 * because the file lives inside a single repository.
 */
export const RepositorySettingsFile = Schema.Struct({
	schemaVersion: Schema.Literal(1),
	defaultProviderId: Schema.NullOr(ProviderId),
	defaultModel: Schema.NullOr(Schema.String),
	defaultRuntimeMode: Schema.NullOr(RuntimeMode),
	autoCreateWorktree: Schema.Boolean,
	worktreeBaseDir: Schema.NullOr(Schema.String),
	archiveCleanupScript: Schema.NullOr(Schema.String),
	setupScript: Schema.NullOr(Schema.String),
	runScript: Schema.NullOr(Schema.String),
	autoRunAfterSetup: Schema.Boolean,
	environmentVariables: Schema.Record(Schema.String, Schema.String),
	cloudEnvironmentVariables: Schema.Record(Schema.String, Schema.String).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed({})),
	),
	fileIncludeGlobs: Schema.String,
	mcpDisabledServers: Schema.Array(Schema.String),
});
export type RepositorySettingsFile = typeof RepositorySettingsFile.Type;

export const RepositorySettingsGetRpc = Rpc.make("repositorySettings.get", {
	payload: Schema.Struct({ projectId: FolderId }),
	success: RepositorySettings,
});

export const RepositorySettingsUpdateRpc = Rpc.make(
	"repositorySettings.update",
	{
		payload: Schema.Struct({
			projectId: FolderId,
			patch: RepositorySettingsPatch,
		}),
		success: RepositorySettings,
	},
);
