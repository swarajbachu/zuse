import { SessionId, ThreadGoal } from "@zuse/contracts";
import { layer } from "@zuse/sqlite";
import { Deferred, Effect, Fiber, Option, Stream } from "effect";
import { expect, it } from "vitest";
import { makeConversationGoalState } from "../../src/conversation/core/conversation-goal-state.ts";

const sessionId = SessionId.make("pending-goal-read");
const paused = ThreadGoal.make({
	threadId: "thread",
	objective: "work",
	status: "paused",
	tokenBudget: null,
	tokensUsed: 0,
	timeUsedSeconds: 0,
	createdAt: 1,
	updatedAt: 2,
});
it.each([
	paused,
	null,
])("delivers goal control updates before the initial native read finishes (%s)", async (goal) => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const state = yield* makeConversationGoalState();
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<ThreadGoal | null>();
				const read = yield* state
					.stream(
						sessionId,
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
						),
					)
					.pipe(Stream.runHead, Effect.forkScoped);
				yield* Deferred.await(entered);
				yield* state.publish(sessionId, goal);
				const first = yield* Effect.raceFirst(
					Fiber.join(read).pipe(Effect.map(Option.getOrNull)),
					Effect.sleep("20 millis").pipe(Effect.as("timed-out")),
				);
				yield* Deferred.succeed(release, null);
				expect(first).toEqual({ sessionId, goal });
				expect(state.current(sessionId)).toEqual(goal);
			}),
		).pipe(Effect.provide(layer({ filename: ":memory:" }))),
	);
});
