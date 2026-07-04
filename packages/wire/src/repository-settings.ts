import { Rpc } from "@effect/rpc";
import { Schema } from "effect";

import { ProviderId, RuntimeMode } from "./agent.ts";
import { FolderId } from "./ids.ts";

/**
 * Per-repository overrides on top of the global Settings. A `null` field
 * means "fall through to global default"; the renderer is responsible for
 * collapsing this layer at read-time. Persisted in `.memoize/settings.json`
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
   * default: `~/.memoize/<repo-name>-<projectId-short>/`.
   */
  worktreeBaseDir: Schema.NullOr(Schema.String),
  /**
   * Optional user-authored shell body to run before archiving a chat that is
   * bound to a worktree. Empty/null means archive without cleanup.
   */
  archiveCleanupScript: Schema.NullOr(Schema.String),
  /**
   * When true, Memoize removes the chat's git worktree after a successful
   * archive cleanup script. The branch is preserved and unarchive restores
   * the checkout from the archived metadata.
   */
  archiveRemoveWorktree: Schema.Boolean,
  setupScript: Schema.NullOr(Schema.String),
  runScript: Schema.NullOr(Schema.String),
  autoRunAfterSetup: Schema.Boolean,
  environmentVariables: Schema.Record({
    key: Schema.String,
    value: Schema.String,
  }),
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
  archiveRemoveWorktree: Schema.optional(Schema.Boolean),
  setupScript: Schema.optional(Schema.NullOr(Schema.String)),
  runScript: Schema.optional(Schema.NullOr(Schema.String)),
  autoRunAfterSetup: Schema.optional(Schema.Boolean),
  environmentVariables: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
});
export type RepositorySettingsPatch = typeof RepositorySettingsPatch.Type;

/**
 * On-disk `.memoize/settings.json` shape. It intentionally omits `projectId`
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
  archiveRemoveWorktree: Schema.Boolean,
  setupScript: Schema.NullOr(Schema.String),
  runScript: Schema.NullOr(Schema.String),
  autoRunAfterSetup: Schema.Boolean,
  environmentVariables: Schema.Record({
    key: Schema.String,
    value: Schema.String,
  }),
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
