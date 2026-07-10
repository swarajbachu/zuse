import { Context, type Effect } from "effect";

import {
  type FolderId,
  type RepositorySettings,
  type RepositorySettingsPatch,
} from "@zuse/wire";

export interface RepositorySettingsServiceShape {
  /**
   * Read settings for a project. Always succeeds — missing rows return a
   * row of `null` overrides + `autoCreateWorktree=false` so the renderer
   * can render the form without a separate "no row yet" branch.
   */
  readonly get: (
    projectId: FolderId,
  ) => Effect.Effect<RepositorySettings>;
  /**
   * Upsert: only fields present on the patch are written. Returns the
   * post-update row so the renderer can refresh local state without a
   * second `get` round-trip.
   */
  readonly update: (
    projectId: FolderId,
    patch: RepositorySettingsPatch,
  ) => Effect.Effect<RepositorySettings>;
}

export class RepositorySettingsService extends Context.Service<RepositorySettingsService, RepositorySettingsServiceShape>()(
  "memoize/RepositorySettingsService",
) {}
