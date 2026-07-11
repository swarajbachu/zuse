import type {
  AgentEvent,
  MessageContent,
  PermissionMode,
  ProviderId,
  ResumeStrategy,
  Session,
  SessionId,
  ThreadGoal,
} from "@zuse/contracts";
import { Effect, Fiber, Ref, type Scope, Stream } from "effect";

import { eventToContent } from "./conversation-message-mapping.ts";

type RelayActivity =
  | "approval-needed"
  | "question-needed"
  | "completed"
  | "error"
  | "running";

export interface ConversationEventRuntimeOptions {
  readonly scope: Scope.Scope;
  readonly events: (sessionId: SessionId) => Stream.Stream<AgentEvent, unknown>;
  readonly providerId: (sessionId: SessionId) => Effect.Effect<ProviderId>;
  readonly setStatus: (
    sessionId: SessionId,
    status: Session["status"],
  ) => Effect.Effect<void>;
  readonly settleTurn: (
    sessionId: SessionId,
    outcome: "completed" | "interrupted" | "error",
  ) => Effect.Effect<void>;
  readonly hasActiveTurn: (sessionId: SessionId) => boolean;
  readonly setResume: (
    sessionId: SessionId,
    cursor: string,
    strategy: ResumeStrategy,
  ) => Effect.Effect<void>;
  readonly setPermissionMode: (
    sessionId: SessionId,
    mode: PermissionMode,
  ) => Effect.Effect<void>;
  readonly publishGoal: (
    sessionId: SessionId,
    goal: ThreadGoal | null,
  ) => Effect.Effect<void>;
  readonly publishRelayActivity: (
    sessionId: SessionId,
    activity: RelayActivity,
  ) => Effect.Effect<void>;
  readonly ignoreError: (providerId: ProviderId, message: string) => boolean;
  readonly isDuplicateToolUse: (
    sessionId: SessionId,
    content: Extract<MessageContent, { readonly _tag: "tool_use" }>,
  ) => Effect.Effect<boolean>;
  readonly persist: (
    sessionId: SessionId,
    content: MessageContent,
  ) => Effect.Effect<void>;
}

export interface ConversationEventRuntime {
  readonly start: (sessionId: SessionId) => Effect.Effect<void>;
  readonly interrupt: (sessionId: SessionId) => Effect.Effect<void>;
}

export const makeConversationEventRuntime = Effect.fn(
  "ConversationEventRuntime.make",
)(function* (
  options: ConversationEventRuntimeOptions,
): Effect.fn.Return<ConversationEventRuntime> {
  const fibers = yield* Ref.make<
    ReadonlyMap<SessionId, Fiber.Fiber<unknown, unknown>>
  >(new Map());

  const start: ConversationEventRuntime["start"] = (sessionId) =>
    Effect.gen(function* () {
      const providerId = yield* options.providerId(sessionId);
      const fiber = yield* Effect.forkIn(
        Stream.runForEach(options.events(sessionId), (event) =>
          Effect.gen(function* () {
            if (event._tag === "Status") {
              if (
                event.status === "running" ||
                event.status === "closed" ||
                event.status === "error" ||
                event.status === "idle"
              ) {
                yield* options.setStatus(sessionId, event.status);
                if (event.status === "running") {
                  yield* options.publishRelayActivity(sessionId, "running");
                }
              }
              return;
            }
            if (event._tag === "Completed") {
              const outcome =
                event.reason === "interrupted"
                  ? "interrupted"
                  : event.reason === "error"
                    ? "error"
                    : "completed";
              yield* options.settleTurn(sessionId, outcome);
              yield* options.setStatus(
                sessionId,
                event.reason === "error" ? "error" : "closed",
              );
              yield* options.publishRelayActivity(
                sessionId,
                event.reason === "error" ? "error" : "completed",
              );
              return;
            }
            if (event._tag === "SessionCursor") {
              yield* options.setResume(sessionId, event.cursor, event.strategy);
              return;
            }
            if (event._tag === "PermissionModeChanged") {
              yield* options.setPermissionMode(sessionId, event.mode);
              return;
            }
            if (event._tag === "GoalUpdated") {
              yield* options.publishGoal(sessionId, event.goal);
              return;
            }
            if (event._tag === "GoalCleared") {
              yield* options.publishGoal(sessionId, null);
              return;
            }
            if (
              event._tag === "Error" &&
              options.ignoreError(providerId, event.message)
            ) {
              return;
            }
            if (event._tag === "PermissionRequest") {
              yield* options.publishRelayActivity(sessionId, "approval-needed");
            }
            if (event._tag === "UserQuestion") {
              yield* options.publishRelayActivity(sessionId, "question-needed");
            }
            const content = eventToContent(event);
            if (content === null) return;
            if (
              content._tag === "tool_use" &&
              (yield* options.isDuplicateToolUse(sessionId, content))
            ) {
              return;
            }
            yield* options.persist(sessionId, content);
            if (event._tag === "Error") {
              yield* options.settleTurn(sessionId, "error");
              yield* options.publishRelayActivity(sessionId, "error");
              yield* options.setStatus(sessionId, "error");
            }
            if (event._tag === "Interrupted") {
              yield* options.settleTurn(sessionId, "interrupted");
              yield* options.setStatus(sessionId, "idle");
            }
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (options.hasActiveTurn(sessionId)) {
                yield* options
                  .settleTurn(sessionId, "error")
                  .pipe(Effect.catchCause(() => Effect.void));
              }
              yield* Effect.logDebug("[ConversationEvents] event stream ended");
              yield* Effect.logDebug(cause);
            }),
          ),
        ),
        options.scope,
      );
      yield* Ref.update(fibers, (current) => {
        const next = new Map(current);
        next.set(sessionId, fiber);
        return next;
      });
    });

  const interrupt: ConversationEventRuntime["interrupt"] = (sessionId) =>
    Effect.gen(function* () {
      const fiber = (yield* Ref.get(fibers)).get(sessionId);
      if (fiber === undefined) return;
      yield* Fiber.interrupt(fiber);
      yield* Ref.update(fibers, (current) => {
        const next = new Map(current);
        next.delete(sessionId);
        return next;
      });
    });

  return { start, interrupt };
});
