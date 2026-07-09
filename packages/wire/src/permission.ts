import { Rpc } from "@effect/rpc";
import { Schema } from "effect";

import { FolderId } from "./ids.ts";
import { SessionId } from "./session.ts";

/**
 * What the agent is asking permission to do. The discriminated union keeps the
 * UI copy and the matcher honest — adding a new kind is a wire change, not a
 * stringly-typed addition. `detail` on the request carries kind-specific data
 * (cwd, args, etc.) that the toast renders for context.
 */
export const PermissionKind = Schema.Union(
  Schema.TaggedStruct("FileWrite", { path: Schema.String }),
  Schema.TaggedStruct("Bash", { command: Schema.String }),
  Schema.TaggedStruct("Network", { url: Schema.String }),
  // Catch-all for tools we don't classify yet (`Read`, `Glob`, MCP, …). The
  // server defaults these to AllowOnce auto-pass for now; surfacing the union
  // member keeps the protocol open without a separate "unknown" path.
  Schema.TaggedStruct("Other", {
    tool: Schema.String,
    summary: Schema.String,
  }),
);
export type PermissionKind = typeof PermissionKind.Type;

/**
 * User's choice in the toast. `AllowForSession` is enforced in the in-process
 * driver loop (server short-circuits a re-prompt with the same kind+key
 * within the same session). `AlwaysAllow` is plumbing for a later folder /
 * global allow-list UI — Phase 4 never produces it.
 */
export const PermissionDecision = Schema.Union(
  Schema.TaggedStruct("AllowOnce", {}),
  Schema.TaggedStruct("AllowForSession", {}),
  Schema.TaggedStruct("Deny", {}),
  Schema.TaggedStruct("AlwaysAllow", {
    scope: Schema.Literal("folder", "global"),
  }),
);
export type PermissionDecision = typeof PermissionDecision.Type;

/**
 * One outstanding prompt. `id` is the server-minted handle the renderer hands
 * back via `permission.decide`. Multiple requests can be in flight for the
 * same session; the toast shows them one at a time.
 */
export class PermissionRequest extends Schema.Class<PermissionRequest>(
  "PermissionRequest",
)({
  id: Schema.String,
  sessionId: SessionId,
  kind: PermissionKind,
  requestedAt: Schema.DateFromString,
  /**
   * When true, the renderer disables `AllowForSession` and `AlwaysAllow` so
   * the user can't silence future matching prompts by accident.
   *
   * Set server-side for more than just credential files:
   *  - sensitive paths (`.env`, `.ssh`, keys, etc.) on file ops
   *  - plan mode (every bash / mutating / network gate)
   *  - a few always-prompt tools (e.g. browser login, ExitPlanMode)
   *
   * Do not treat `forcePrompt` as "this path is sensitive" in the UI —
   * bash/network prompts almost never are; they usually mean plan mode.
   */
  forcePrompt: Schema.Boolean,
}) {}

/**
 * One row from `permission_decisions`, denormalized for the inspector UI.
 * Mirrors the table columns but keeps the kind as the structured wire type
 * so the renderer doesn't re-parse JSON.
 */
export class SavedDecision extends Schema.Class<SavedDecision>("SavedDecision")(
  {
    requestId: Schema.String,
    sessionId: SessionId,
    projectId: Schema.NullOr(FolderId),
    kind: PermissionKind,
    decision: Schema.Literal(
      "AllowOnce",
      "AllowForSession",
      "AlwaysAllow",
      "Deny",
    ),
    scope: Schema.Literal("session", "folder", "global"),
    decidedAt: Schema.DateFromString,
  },
) {}

export class PermissionRequestNotFoundError extends Schema.TaggedError<PermissionRequestNotFoundError>()(
  "PermissionRequestNotFoundError",
  { requestId: Schema.String },
) {}

// ---------------------------------------------------------------------------
// RPCs
// ---------------------------------------------------------------------------

/**
 * Live stream of pending requests across every session. The renderer
 * filters by selected session; broadcasting once and filtering on the
 * client is cheaper than per-session subscriptions and means a session
 * switch doesn't have to tear anything down on the server.
 */
export const PermissionRequestsRpc = Rpc.make("permission.requests", {
  payload: Schema.Struct({}),
  success: PermissionRequest,
  stream: true,
});

export const PermissionDecideRpc = Rpc.make("permission.decide", {
  payload: Schema.Struct({
    requestId: Schema.String,
    decision: PermissionDecision,
  }),
  success: Schema.Void,
  error: PermissionRequestNotFoundError,
});

/**
 * Cold-load helper for renderer hydration. Returns every request that the
 * server is still awaiting a decision for, scoped to one session. Used on
 * mount and after a reconnection so the toast comes back without waiting for
 * the next stream message.
 */
export const PermissionListPendingRpc = Rpc.make("permission.listPending", {
  payload: Schema.Struct({ sessionId: SessionId }),
  success: Schema.Array(PermissionRequest),
});

/**
 * Inspector RPCs. `listDecisions` returns saved decisions optionally filtered
 * by project (typical use is per-project from the projects sidebar). `revoke`
 * deletes a single row by `requestId` so the next matching request re-prompts.
 */
export const PermissionListDecisionsRpc = Rpc.make(
  "permission.listDecisions",
  {
    payload: Schema.Struct({
      projectId: Schema.optional(FolderId),
    }),
    success: Schema.Array(SavedDecision),
  },
);

export const PermissionRevokeDecisionRpc = Rpc.make(
  "permission.revokeDecision",
  {
    payload: Schema.Struct({ requestId: Schema.String }),
    success: Schema.Void,
  },
);
