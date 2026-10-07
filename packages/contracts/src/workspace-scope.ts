import { Schema } from "effect";

/** Ownership scope, not a chat/worktree ID or the authenticated human identity. */
export const WorkspaceScope = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("personal") }),
	Schema.Struct({
		kind: Schema.Literal("organization"),
		organizationId: Schema.String.check(
			Schema.isMinLength(1),
			Schema.isMaxLength(128),
			Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
		),
	}),
]);
export type WorkspaceScope = typeof WorkspaceScope.Type;

/** Omitted by legacy clients (Personal only); explicit values must be validated. */
export const WORKSPACE_SCOPE_HEADER = "x-zuse-workspace";
/** Versioned URL namespace makes older API deployments reject scoped writes. */
export const WORKSPACE_API_PREFIX = "/v1/organization-workspaces/";
export const WorkspaceScopeHeader = Schema.String.check(
	Schema.isPattern(/^(?:personal|organization:[A-Za-z0-9_-]{1,128})$/u),
);

/** Persisted owner of a desktop project row; same encoding as the scope header. */
export const WorkspaceKey = WorkspaceScopeHeader;
export type WorkspaceKey = typeof WorkspaceKey.Type;
export const PERSONAL_WORKSPACE_KEY: WorkspaceKey = "personal";
