import {
  type AgentSessionNotFoundError,
  GoalUnsupportedError,
  type ProviderId,
  type Session,
  type SessionId,
  SessionNotFoundError,
  type SessionStartError,
  type ThreadGoal,
  type ThreadGoalSetInput,
} from "@zuse/contracts";
import { Effect, Stream } from "effect";

import type { ConversationGoalState } from "./conversation-goal-state.ts";
import type { ConversationOperations } from "./services/conversation-services.ts";
import type { ProviderServiceShape } from "./services/provider-service.ts";

const GOAL_CAPABLE_PROVIDERS: ReadonlySet<ProviderId> = new Set([
  "codex",
  "grok",
]);

export const isGoalCapableProvider = (providerId: ProviderId): boolean =>
  GOAL_CAPABLE_PROVIDERS.has(providerId);

export interface ConversationGoalOperationsOptions {
  readonly provider: Pick<
    ProviderServiceShape,
    "getGoal" | "setGoal" | "clearGoal"
  >;
  readonly state: ConversationGoalState;
  readonly lookupSession: (
    sessionId: SessionId,
  ) => Effect.Effect<Session, SessionNotFoundError>;
  readonly openProviderSession: (
    session: Session,
  ) => Effect.Effect<void, SessionStartError>;
}

export type ConversationGoalOperations = Pick<
  ConversationOperations,
  "getGoal" | "setGoal" | "clearGoal" | "streamGoal"
>;

export const makeConversationGoalOperations = (
  options: ConversationGoalOperationsOptions,
): ConversationGoalOperations => {
  const ensureSession = (
    sessionId: SessionId,
  ): Effect.Effect<Session, SessionNotFoundError | GoalUnsupportedError> =>
    Effect.gen(function* () {
      const session = yield* options.lookupSession(sessionId);
      if (!isGoalCapableProvider(session.providerId)) {
        return yield* Effect.fail(
          new GoalUnsupportedError({ providerId: session.providerId }),
        );
      }
      return session;
    });

  const sessionNotFound =
    (sessionId: SessionId) =>
    (
      _error: AgentSessionNotFoundError,
    ): Effect.Effect<never, SessionNotFoundError> =>
      Effect.fail(new SessionNotFoundError({ sessionId }));

  const setWithLiveProvider = (
    session: Session,
    goal: ThreadGoalSetInput,
  ): Effect.Effect<ThreadGoal, SessionNotFoundError | SessionStartError> => {
    const attempt = options.provider.setGoal(session.id, goal);
    const awaitBoot = (
      retriesLeft: number,
    ): Effect.Effect<
      ThreadGoal,
      AgentSessionNotFoundError | SessionNotFoundError
    > =>
      attempt.pipe(
        Effect.catchTag("AgentSessionNotFoundError", (error) =>
          Effect.gen(function* () {
            const latest = yield* options.lookupSession(session.id);
            if (retriesLeft <= 0 || latest.status !== "booting") {
              return yield* Effect.fail(error);
            }
            yield* Effect.sleep("250 millis");
            return yield* awaitBoot(retriesLeft - 1);
          }),
        ),
      );
    return awaitBoot(240).pipe(
      Effect.catchTag("AgentSessionNotFoundError", () =>
        options
          .openProviderSession(session)
          .pipe(
            Effect.andThen(options.provider.setGoal(session.id, goal)),
            Effect.catchTag(
              "AgentSessionNotFoundError",
              sessionNotFound(session.id),
            ),
          ),
      ),
    );
  };

  return {
    getGoal: (sessionId) =>
      Effect.gen(function* () {
        yield* ensureSession(sessionId);
        const goal = yield* options.provider
          .getGoal(sessionId)
          .pipe(
            Effect.catchTag(
              "AgentSessionNotFoundError",
              sessionNotFound(sessionId),
            ),
          );
        yield* options.state.publish(sessionId, goal);
        return goal;
      }),
    setGoal: (sessionId, goalInput) =>
      Effect.gen(function* () {
        const session = yield* ensureSession(sessionId);
        const goal = yield* setWithLiveProvider(session, goalInput);
        yield* options.state.publish(sessionId, goal);
        return goal;
      }),
    clearGoal: (sessionId) =>
      Effect.gen(function* () {
        yield* ensureSession(sessionId);
        yield* options.provider
          .clearGoal(sessionId)
          .pipe(
            Effect.catchTag(
              "AgentSessionNotFoundError",
              sessionNotFound(sessionId),
            ),
          );
        yield* options.state.publish(sessionId, null);
      }),
    streamGoal: (sessionId) =>
      Stream.unwrap(
        ensureSession(sessionId).pipe(
          Effect.as(
            options.state.stream(
              sessionId,
              options.provider
                .getGoal(sessionId)
                .pipe(Effect.catch(() => Effect.succeed(null))),
            ),
          ),
        ),
      ),
  };
};
