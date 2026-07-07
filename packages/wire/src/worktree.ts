import { Rpc } from "@effect/rpc";
import { Schema } from "effect";

import { FolderId, WorktreeId } from "./ids.ts";
import { PokemonSummary } from "./pokemon.ts";

export const WorktreeSetupStatus = Schema.Literal(
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
);
export type WorktreeSetupStatus = typeof WorktreeSetupStatus.Type;

/**
 * A git worktree owned by memoize. Lives at
 * `~/.zuse/<repo-name>-<projectId-short>/<name>/` so it stays out of the
 * source repo (no `.git/info/exclude` rewriting, no stray entries in `git
 * status`, no `.zuse/` paths leaking into file pickers). Branch matches
 * `<name>` (e.g. `pikachu`).
 */
export class Worktree extends Schema.Class<Worktree>("Worktree")({
  id: WorktreeId,
  projectId: FolderId,
  path: Schema.String,
  name: Schema.String,
  branch: Schema.String,
  baseBranch: Schema.String,
  createdAt: Schema.DateFromString,
  setupStatus: WorktreeSetupStatus,
  setupOutput: Schema.String,
  setupStartedAt: Schema.NullOr(Schema.DateFromString),
  setupFinishedAt: Schema.NullOr(Schema.DateFromString),
  pokemon: Schema.NullOr(PokemonSummary),
}) {}

export class WorktreeNotFoundError extends Schema.TaggedError<WorktreeNotFoundError>()(
  "WorktreeNotFoundError",
  { worktreeId: WorktreeId },
) {}

/**
 * Live setup events streamed while a worktree's setup script runs. `chunk`
 * carries the FULL accumulated (already-truncated) output so the renderer can
 * replace `setupOutput` wholesale; `status` carries each setupStatus
 * transition + timestamps. The stream completes once setup reaches a terminal
 * status (succeeded / failed / skipped).
 */
export const WorktreeSetupChunk = Schema.TaggedStruct("chunk", {
  worktreeId: WorktreeId,
  output: Schema.String,
});

export const WorktreeSetupStatusEvent = Schema.TaggedStruct("status", {
  worktreeId: WorktreeId,
  status: WorktreeSetupStatus,
  setupStartedAt: Schema.NullOr(Schema.DateFromString),
  setupFinishedAt: Schema.NullOr(Schema.DateFromString),
});

export const WorktreeSetupEvent = Schema.Union(
  WorktreeSetupChunk,
  WorktreeSetupStatusEvent,
);
export type WorktreeSetupEvent = typeof WorktreeSetupEvent.Type;

export class WorktreeCreateError extends Schema.TaggedError<WorktreeCreateError>()(
  "WorktreeCreateError",
  { projectId: FolderId, reason: Schema.String },
) {}

export class WorktreeRemoveError extends Schema.TaggedError<WorktreeRemoveError>()(
  "WorktreeRemoveError",
  { worktreeId: WorktreeId, reason: Schema.String },
) {}

export class WorktreeDirtyError extends Schema.TaggedError<WorktreeDirtyError>()(
  "WorktreeDirtyError",
  { worktreeId: WorktreeId },
) {}

export class WorktreeSetupError extends Schema.TaggedError<WorktreeSetupError>()(
  "WorktreeSetupError",
  { worktreeId: WorktreeId, reason: Schema.String },
) {}

const WorktreeErrors = Schema.Union(
  WorktreeCreateError,
  WorktreeRemoveError,
  WorktreeNotFoundError,
  WorktreeDirtyError,
  WorktreeSetupError,
);

/**
 * Optional source for a worktree checkout. When omitted, `worktree.create`
 * behaves as before: allocate a fresh Pokémon branch off `origin/<default>`.
 * When present, the worktree checks out an EXISTING ref instead:
 *   - `branch` → check out that branch (tracking `origin/<branch>` when it's a
 *     remote branch), used by the "Create from → Branches" picker.
 *   - `pr` → `gh pr checkout <number>` inside the new worktree, used by
 *     "Create from → PRs" (handles fork PRs + tracking).
 * The directory still gets a Pokémon name/mascot; only the checked-out branch
 * differs.
 */
export const WorktreeCreateSource = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("branch"),
    branch: Schema.String,
    remote: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.Literal("pr"),
    number: Schema.Number,
    headRefName: Schema.String,
  }),
);
export type WorktreeCreateSource = typeof WorktreeCreateSource.Type;

export const WorktreeCreateRpc = Rpc.make("worktree.create", {
  payload: Schema.Struct({
    projectId: FolderId,
    source: Schema.optional(WorktreeCreateSource),
  }),
  success: Worktree,
  error: WorktreeCreateError,
});

export const WorktreeListRpc = Rpc.make("worktree.list", {
  payload: Schema.Struct({ projectId: FolderId }),
  success: Schema.Array(Worktree),
});

export const WorktreeGetRpc = Rpc.make("worktree.get", {
  payload: Schema.Struct({ worktreeId: WorktreeId }),
  success: Schema.NullOr(Worktree),
});

/**
 * Subscribe to a worktree's live setup output + status. Mirrors `pty.output`:
 * a long-lived stream the renderer drains while `setupStatus === "running"`.
 * Seeds the current persisted snapshot on subscribe so a late subscriber
 * (after a fast setup already finished) still sees the terminal state.
 */
export const WorktreeSetupStreamRpc = Rpc.make("worktree.setupStream", {
  payload: Schema.Struct({ worktreeId: WorktreeId }),
  success: WorktreeSetupEvent,
  error: WorktreeNotFoundError,
  stream: true,
});

export const WorktreeRerunSetupRpc = Rpc.make("worktree.rerunSetup", {
  payload: Schema.Struct({ worktreeId: WorktreeId }),
  success: Worktree,
  error: WorktreeErrors,
});

export const WorktreeStartRunRpc = Rpc.make("worktree.startRun", {
  payload: Schema.Struct({ worktreeId: WorktreeId }),
  success: Schema.Struct({
    cwd: Schema.String,
    script: Schema.String,
    env: Schema.Record({ key: Schema.String, value: Schema.String }),
  }),
  error: WorktreeErrors,
});

/**
 * Remove a worktree's checkout. By default refuses to delete a dirty
 * worktree (`WorktreeDirtyError`); callers pass `force: true` after
 * confirming with the user. The branch is preserved either way — v1 doesn't
 * auto-delete branches.
 */
export const WorktreeRemoveRpc = Rpc.make("worktree.remove", {
  payload: Schema.Struct({
    worktreeId: WorktreeId,
    force: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Void,
  error: WorktreeErrors,
});
