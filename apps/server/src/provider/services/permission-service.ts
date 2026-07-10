import { Context, type Effect, type Stream } from "effect";

import type {
  FolderId,
  PermissionDecision,
  PermissionKind,
  PermissionRequest,
  PermissionRequestNotFoundError,
  SavedDecision,
  SessionId,
} from "@zuse/wire";

/**
 * Bridge between provider drivers (which call `request` from inside their
 * SDK permission callback) and the renderer (which subscribes to `requests`,
 * shows a toast, then calls `decide`).
 *
 * `request` blocks the driver until a decision is made or the session
 * tears down. `decide` resolves whichever deferred is keyed by `requestId`.
 * `listPending` lets a freshly-mounted UI hydrate without waiting for the
 * next stream message.
 *
 * "Allow for session" is enforced inside `request` itself: before publishing
 * a new `PermissionRequest` we look up `permission_decisions` for an
 * existing `AllowForSession` row matching `(sessionId, kindTag, kindKey)`,
 * and short-circuit with an `AllowOnce` decision when one exists. This
 * mirrors the SDK's own session-scoped suppression and keeps the prompt
 * stream quiet for repeat tool calls within a session.
 */
/**
 * Options for `request`. `projectId` is required so folder-scoped
 * `AlwaysAllow` rows can short-circuit a re-prompt across sessions in the
 * same project. `forcePrompt` skips the existing-decision lookup entirely —
 * the driver sets it for sensitive paths so prior `AllowForSession` /
 * `AlwaysAllow` decisions can't silence them.
 */
export interface RequestOptions {
  readonly projectId: FolderId;
  readonly forcePrompt?: boolean;
}

export interface PermissionServiceShape {
  readonly request: (
    sessionId: SessionId,
    kind: PermissionKind,
    options: RequestOptions,
  ) => Effect.Effect<PermissionDecision>;

  readonly decide: (
    requestId: string,
    decision: PermissionDecision,
  ) => Effect.Effect<void, PermissionRequestNotFoundError>;

  readonly listPending: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<PermissionRequest>>;

  readonly requests: () => Stream.Stream<PermissionRequest>;

  /**
   * Inspector queries. `listDecisions` returns persisted decisions filtered
   * by project (or all when no filter is given). `revokeDecision` deletes a
   * single row by `requestId` so the next matching tool call re-prompts.
   */
  readonly listDecisions: (filter: {
    readonly projectId?: FolderId;
  }) => Effect.Effect<ReadonlyArray<SavedDecision>>;

  readonly revokeDecision: (requestId: string) => Effect.Effect<void>;
}

export class PermissionService extends Context.Service<PermissionService, PermissionServiceShape>()(
  "memoize/PermissionService",
) {}
