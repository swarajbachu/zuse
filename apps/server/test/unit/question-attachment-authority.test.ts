import { AgentItemId, AgentSessionId } from "@zuse/contracts";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { makeQuestionAttachmentAuthority } from "../../src/provider/question-attachment-authority.ts";

const questions = [
	{
		question: "Choose one",
		options: ["First", "Second"],
		multiSelect: false,
	},
] as const;

describe("question attachment authority", () => {
	it("keeps one provider delivery idempotent until its durable acknowledgement", async () => {
		const authority = makeQuestionAttachmentAuthority();
		const sessionId = AgentSessionId.make("question-session");
		const itemId = AgentItemId.make("question-item");
		const answers = [{ questionIndex: 0, selected: [0] }];
		let providerDeliveries = 0;
		const deliver = () =>
			authority.deliverAnswer(
				sessionId,
				itemId,
				answers,
				Effect.sync(() => {
					providerDeliveries += 1;
				}),
			);

		expect(authority.attach({ sessionId, itemId }, questions)).toBe("attached");
		expect(authority.attach({ sessionId, itemId }, questions)).toBe(
			"duplicate",
		);
		await Effect.runPromise(deliver());
		await Effect.runPromise(deliver());
		expect(providerDeliveries).toBe(1);

		const conflict = await Effect.runPromiseExit(
			authority.deliverAnswer(
				sessionId,
				itemId,
				[{ questionIndex: 0, selected: [1] }],
				Effect.sync(() => {
					providerDeliveries += 1;
				}),
			),
		);
		expect(Exit.isFailure(conflict)).toBe(true);
		expect(providerDeliveries).toBe(1);

		expect(authority.detach(sessionId, itemId)).toBe(true);
		expect(Exit.isFailure(await Effect.runPromiseExit(deliver()))).toBe(true);
		expect(providerDeliveries).toBe(1);
	});

	it("commits the in-memory delivery marker before observing interruption", async () => {
		let providerDeliveries = 0;
		await Effect.runPromise(
			Effect.gen(function* () {
				const authority = makeQuestionAttachmentAuthority();
				const sessionId = AgentSessionId.make("interrupt-session");
				const itemId = AgentItemId.make("interrupt-item");
				const providerReturned = yield* Deferred.make<void>();
				expect(authority.attach({ sessionId, itemId }, questions)).toBe(
					"attached",
				);
				const delivery = yield* authority
					.deliverAnswer(
						sessionId,
						itemId,
						[{ questionIndex: 0, selected: [0] }],
						Effect.uninterruptible(
							Effect.sync(() => {
								providerDeliveries += 1;
							}).pipe(
								Effect.andThen(Deferred.succeed(providerReturned, undefined)),
							),
						),
					)
					.pipe(Effect.forkChild);
				yield* Deferred.await(providerReturned);
				yield* Fiber.interrupt(delivery);
				yield* authority.deliverAnswer(
					sessionId,
					itemId,
					[{ questionIndex: 0, selected: [0] }],
					Effect.sync(() => {
						providerDeliveries += 1;
					}),
				);
			}),
		);

		expect(providerDeliveries).toBe(1);
	});

	it("serializes concurrent identical and conflicting deliveries", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const authority = makeQuestionAttachmentAuthority();
				const sessionId = AgentSessionId.make("concurrent-session");
				const itemId = AgentItemId.make("concurrent-item");
				const providerStarted = yield* Deferred.make<void>();
				const releaseProvider = yield* Deferred.make<void>();
				let providerDeliveries = 0;
				expect(authority.attach({ sessionId, itemId }, questions)).toBe(
					"attached",
				);

				const providerEffect = Effect.sync(() => {
					providerDeliveries += 1;
				}).pipe(
					Effect.andThen(Deferred.succeed(providerStarted, undefined)),
					Effect.andThen(Deferred.await(releaseProvider)),
				);
				const first = yield* authority
					.deliverAnswer(
						sessionId,
						itemId,
						[{ questionIndex: 0, selected: [0] }],
						providerEffect,
					)
					.pipe(Effect.forkChild);
				yield* Deferred.await(providerStarted);
				const identical = yield* authority
					.deliverAnswer(
						sessionId,
						itemId,
						[{ questionIndex: 0, selected: [0] }],
						providerEffect,
					)
					.pipe(Effect.forkChild);
				const conflicting = yield* authority
					.deliverAnswer(
						sessionId,
						itemId,
						[{ questionIndex: 0, selected: [1] }],
						providerEffect,
					)
					.pipe(Effect.forkChild);
				yield* Effect.sleep("10 millis");
				expect(providerDeliveries).toBe(1);

				yield* Deferred.succeed(releaseProvider, undefined);
				yield* Fiber.join(first);
				yield* Fiber.join(identical);
				const conflictExit = yield* Fiber.await(conflicting);
				expect(Exit.isFailure(conflictExit)).toBe(true);
				expect(providerDeliveries).toBe(1);
			}),
		);
	});

	it("keeps failed delivery retryable and bounds entries until acknowledgement", async () => {
		const authority = makeQuestionAttachmentAuthority<string>({
			maxEntries: 1,
		});
		const sessionId = AgentSessionId.make("bounded-session");
		const firstItemId = AgentItemId.make("first-item");
		const secondItemId = AgentItemId.make("second-item");
		expect(
			authority.attach({ sessionId, itemId: firstItemId }, questions),
		).toBe("attached");
		expect(
			Exit.isFailure(
				await Effect.runPromiseExit(
					authority.deliverAnswer(
						sessionId,
						firstItemId,
						[{ questionIndex: 0, selected: [0] }],
						Effect.fail("provider failed"),
					),
				),
			),
		).toBe(true);
		let deliveries = 0;
		await Effect.runPromise(
			authority.deliverAnswer(
				sessionId,
				firstItemId,
				[{ questionIndex: 0, selected: [0] }],
				Effect.sync(() => {
					deliveries += 1;
				}),
			),
		);
		expect(
			authority.attach({ sessionId, itemId: secondItemId }, questions),
		).toBe("full");
		await Effect.runPromise(
			authority.deliverAnswer(
				sessionId,
				firstItemId,
				[{ questionIndex: 0, selected: [0] }],
				Effect.sync(() => {
					deliveries += 1;
				}),
			),
		);
		expect(deliveries).toBe(1);
		expect(authority.detach(sessionId, firstItemId)).toBe(true);
		expect(
			authority.attach({ sessionId, itemId: secondItemId }, questions),
		).toBe("attached");
	});

	it("times out a detached provider worker and makes the callback retryable", async () => {
		const authority = makeQuestionAttachmentAuthority({
			deliveryTimeout: "10 millis",
		});
		const sessionId = AgentSessionId.make("timeout-session");
		const itemId = AgentItemId.make("timeout-item");
		expect(authority.attach({ sessionId, itemId }, questions)).toBe("attached");
		const timedOut = await Effect.runPromiseExit(
			authority.deliverAnswer(
				sessionId,
				itemId,
				[{ questionIndex: 0, selected: [0] }],
				Effect.never,
			),
		);
		expect(Exit.isFailure(timedOut)).toBe(true);

		let deliveries = 0;
		await Effect.runPromise(
			authority.deliverAnswer(
				sessionId,
				itemId,
				[{ questionIndex: 0, selected: [0] }],
				Effect.sync(() => {
					deliveries += 1;
				}),
			),
		);
		expect(deliveries).toBe(1);
	});

	it("rejects malformed answers against the attached question before delivery", async () => {
		const authority = makeQuestionAttachmentAuthority();
		const sessionId = AgentSessionId.make("validation-session");
		const itemId = AgentItemId.make("validation-item");
		expect(authority.attach({ sessionId, itemId }, questions)).toBe("attached");
		let providerDeliveries = 0;
		const malformed = [{ questionIndex: 0, selected: [99] }];

		expect(
			Exit.isFailure(
				await Effect.runPromiseExit(
					authority.validateAnswer(sessionId, itemId, malformed),
				),
			),
		).toBe(true);
		expect(
			Exit.isFailure(
				await Effect.runPromiseExit(
					authority.deliverAnswer(
						sessionId,
						itemId,
						malformed,
						Effect.sync(() => {
							providerDeliveries += 1;
						}),
					),
				),
			),
		).toBe(true);
		expect(providerDeliveries).toBe(0);
	});

	it("makes cancellation retry-idempotent and conflicts it with an answer", async () => {
		const authority = makeQuestionAttachmentAuthority();
		const sessionId = AgentSessionId.make("cancel-session");
		const itemId = AgentItemId.make("cancel-item");
		expect(authority.attach({ sessionId, itemId }, questions)).toBe("attached");
		let providerCancellations = 0;
		const cancel = () =>
			authority.deliverCancellation(
				sessionId,
				itemId,
				Effect.sync(() => {
					providerCancellations += 1;
				}),
			);

		await Effect.runPromise(cancel());
		await Effect.runPromise(cancel());
		expect(providerCancellations).toBe(1);
		expect(
			Exit.isFailure(
				await Effect.runPromiseExit(
					authority.deliverAnswer(
						sessionId,
						itemId,
						[{ questionIndex: 0, selected: [0] }],
						Effect.void,
					),
				),
			),
		).toBe(true);
		expect(providerCancellations).toBe(1);
	});

	it("keeps the original callback actionable after conflicting metadata", async () => {
		const authority = makeQuestionAttachmentAuthority();
		const sessionId = AgentSessionId.make("duplicate-session");
		const itemId = AgentItemId.make("duplicate-item");
		expect(authority.attach({ sessionId, itemId }, questions)).toBe("attached");
		expect(
			authority.attach(
				{ sessionId, itemId },
				questions.map((question) => ({ ...question })),
			),
		).toBe("duplicate");
		expect(
			authority.attach({ sessionId, itemId }, [
				{ ...questions[0], options: ["Only"] },
			]),
		).toBe("conflict");
		expect(authority.snapshot()).toEqual([{ sessionId, itemId }]);
		let deliveries = 0;
		await Effect.runPromise(
			authority.deliverAnswer(
				sessionId,
				itemId,
				[{ questionIndex: 0, selected: [1] }],
				Effect.sync(() => {
					deliveries += 1;
				}),
			),
		);
		expect(deliveries).toBe(1);
	});
});
