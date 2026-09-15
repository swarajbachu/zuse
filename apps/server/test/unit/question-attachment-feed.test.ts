import { AgentItemId, AgentSessionId } from "@zuse/contracts";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { makeQuestionAttachmentSnapshotFeed } from "../../src/provider/question-attachment-feed.ts";

describe("question attachment snapshot feed", () => {
	it("conflates slow-subscriber churn to the latest complete state", async () => {
		const observed = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const feed = yield* makeQuestionAttachmentSnapshotFeed;
					const firstObserved = yield* Deferred.make<void>();
					const releaseConsumer = yield* Deferred.make<void>();
					const changes: Array<{
						readonly _tag: "snapshot";
						readonly attachments: ReadonlyArray<{
							readonly sessionId: AgentSessionId;
							readonly itemId: AgentItemId;
						}>;
					}> = [];
					const consumer = yield* feed
						.stream(() => [])
						.pipe(
							Stream.take(2),
							Stream.runForEach((change) =>
								Effect.gen(function* () {
									changes.push(change);
									if (changes.length !== 1) return;
									yield* Deferred.succeed(firstObserved, undefined);
									yield* Deferred.await(releaseConsumer);
								}),
							),
							Effect.forkChild,
						);
					yield* Deferred.await(firstObserved);
					for (let index = 0; index < 100; index += 1) {
						yield* feed.publish([
							{
								sessionId: AgentSessionId.make("slow-session"),
								itemId: AgentItemId.make(`item-${index}`),
							},
						]);
					}
					yield* Deferred.succeed(releaseConsumer, undefined);
					yield* Fiber.join(consumer);
					return changes;
				}),
			),
		);

		expect(observed).toEqual([
			{ _tag: "snapshot", attachments: [] },
			{
				_tag: "snapshot",
				attachments: [{ sessionId: "slow-session", itemId: "item-99" }],
			},
		]);
	});
});
