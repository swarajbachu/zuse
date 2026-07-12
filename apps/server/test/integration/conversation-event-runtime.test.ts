import { SessionId } from "@zuse/contracts";
import { Deferred, Effect, Stream } from "effect";
import { describe, expect, test } from "vitest";
import { makeConversationEventRuntime } from "../../src/conversation/core/conversation-event-runtime.ts";

describe("ConversationEventRuntime", () => {
	const options = (
		scope: import("effect").Scope.Scope,
		events: () => Stream.Stream<never>,
		settleTurn: (
			sessionId: SessionId,
			outcome: "completed" | "interrupted" | "error",
		) => Effect.Effect<void> = () => Effect.void,
	) => ({
		scope,
		events,
		providerId: () => Effect.succeed("claude" as const),
		setStatus: () => Effect.void,
		settleTurn,
		setResume: () => Effect.void,
		setPermissionMode: () => Effect.void,
		publishGoal: () => Effect.void,
		publishRelayActivity: () => Effect.void,
		ignoreError: () => false,
		isDuplicateToolUse: () => Effect.succeed(false),
		persist: () => Effect.void,
	});

	test("settles a durable turn when the provider stream ends cleanly", async () => {
		const outcome = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const scope = yield* Effect.scope;
					const settled = yield* Deferred.make<
						"completed" | "interrupted" | "error"
					>();
					const runtime = yield* makeConversationEventRuntime(
						options(
							scope,
							() => Stream.empty,
							(_sessionId, value) =>
								Deferred.succeed(settled, value).pipe(Effect.asVoid),
						),
					);
					yield* runtime.start(SessionId.make("session-1"));
					return yield* Deferred.await(settled).pipe(Effect.timeout(100));
				}),
			),
		);

		expect(outcome).toBe("error");
	});

	test("replaces the previous subscription and releases it", async () => {
		let active = 0;
		let maximumActive = 0;
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const scope = yield* Effect.scope;
					const events = () =>
						Stream.scoped(
							Stream.fromEffect(
								Effect.acquireRelease(
									Effect.sync(() => {
										active += 1;
										maximumActive = Math.max(maximumActive, active);
									}),
									() => Effect.sync(() => (active -= 1)),
								),
							).pipe(Stream.drain, Stream.concat(Stream.never)),
						);
					const runtime = yield* makeConversationEventRuntime(
						options(scope, events),
					);
					const sessionId = SessionId.make("session-1");
					yield* runtime.start(sessionId);
					yield* Effect.sleep(1);
					yield* runtime.start(sessionId);
					yield* Effect.sleep(1);
					yield* runtime.interrupt(sessionId);
				}),
			),
		);

		expect(maximumActive).toBe(1);
		expect(active).toBe(0);
	});
});
