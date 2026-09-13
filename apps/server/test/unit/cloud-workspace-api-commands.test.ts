import { CLOUD_RUNTIME_TURN_REPLY_MAX_LENGTH } from "@zuse/contracts";
import type { StoredEvent } from "@zuse/domain/engine/dispatch";
import { Deferred, Effect, Fiber, Ref, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	makeCloudApiCommandPump,
	runCloudApiTurnEventStream,
} from "../../src/api/cloud-workspace-api-commands.ts";

const command = (messageId: string, text: string, seq = 1) => ({
	messageId,
	commandId: `api:${messageId}`,
	turnId: `turn:${messageId}`,
	sessionId: "session-1",
	text,
	seq,
});

const storedEvent = (
	sequence: number,
	event: StoredEvent["event"],
	streamId = "session-1",
): StoredEvent => ({
	eventId: `event-${sequence}`,
	correlationId: `correlation-${sequence}`,
	causationEventId: null,
	streamId,
	streamVersion: sequence,
	sequence,
	event,
});

describe("cloud api command pump", () => {
	it("delivers only the oldest command and acks its exact turn", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const delivered = yield* Ref.make<ReadonlyArray<string>>([]);
				const acked = yield* Ref.make<
					ReadonlyArray<{ readonly messageId: string; readonly turnId: string }>
				>([]);
				const pump = yield* makeCloudApiCommandPump({
					fetchCommands: Effect.succeed({
						commands: [command("m2", "second", 2), command("m1", "first", 1)],
					}),
					deliver: (item) =>
						Ref.update(delivered, (items) => [...items, item.commandId]).pipe(
							Effect.as(item.turnId),
						),
					ack: (messageId, turnId) =>
						Ref.update(acked, (items) => [...items, { messageId, turnId }]),
				});
				yield* pump.drain;
				expect(yield* Ref.get(delivered)).toEqual(["api:m1"]);
				expect(yield* Ref.get(acked)).toEqual([
					{ messageId: "m1", turnId: "turn:m1" },
				]);
			}),
		);
	});

	it("derives a stable turn when a pre-change API omits it", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const { turnId: _omitted, ...legacyCommand } = command(
					"legacy-message",
					"legacy",
				);
				const delivered = yield* Ref.make<ReadonlyArray<string>>([]);
				const acked = yield* Ref.make<
					ReadonlyArray<{
						readonly turnId: string;
						readonly commandTurnId: string;
					}>
				>([]);
				const pump = yield* makeCloudApiCommandPump({
					fetchCommands: Effect.succeed({ commands: [legacyCommand] }),
					deliver: (item) =>
						Ref.update(delivered, (items) => [...items, item.turnId]).pipe(
							Effect.as(item.turnId),
						),
					ack: (_messageId, turnId, commandTurnId) =>
						Ref.update(acked, (items) => [...items, { turnId, commandTurnId }]),
				});
				yield* pump.drain;
				expect(yield* Ref.get(delivered)).toEqual(["turn_legacy-message"]);
				expect(yield* Ref.get(acked)).toEqual([
					{
						turnId: "turn_legacy-message",
						commandTurnId: "turn_legacy-message",
					},
				]);
			}),
		);
	});

	it("acks the durable turn returned by an idempotent domain replay", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const acked = yield* Ref.make<
					ReadonlyArray<{
						readonly turnId: string;
						readonly commandTurnId: string;
					}>
				>([]);
				const pump = yield* makeCloudApiCommandPump({
					fetchCommands: Effect.succeed({
						commands: [command("legacy-receipt", "already accepted")],
					}),
					// A pre-upgrade runtime accepted this command under a random turn
					// before losing its ACK. Domain replay returns that durable identity.
					deliver: () => Effect.succeed("turn-old-runtime-random"),
					ack: (_messageId, turnId, commandTurnId) =>
						Ref.update(acked, (items) => [...items, { turnId, commandTurnId }]),
				});

				yield* pump.drain;
				expect(yield* Ref.get(acked)).toEqual([
					{
						turnId: "turn-old-runtime-random",
						commandTurnId: "turn:legacy-receipt",
					},
				]);
			}),
		);
	});

	it("does not skip the oldest command when delivery defects", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const delivered = yield* Ref.make<ReadonlyArray<string>>([]);
				const acked = yield* Ref.make<ReadonlyArray<string>>([]);
				const pump = yield* makeCloudApiCommandPump({
					fetchCommands: Effect.succeed({
						commands: [command("bad", "boom", 1), command("good", "ok", 2)],
					}),
					deliver: (item) =>
						Ref.update(delivered, (items) => [...items, item.messageId]).pipe(
							Effect.andThen(Effect.die("turn_already_running")),
						),
					ack: (messageId) =>
						Ref.update(acked, (items) => [...items, messageId]),
				});
				yield* pump.drain;
				expect(yield* Ref.get(delivered)).toEqual(["bad"]);
				expect(yield* Ref.get(acked)).toEqual([]);
			}),
		);
	});

	it("coalesces overlapping drains and waits for a later signal before the next command", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const pending = yield* Ref.make<
					ReadonlyArray<ReturnType<typeof command>>
				>([command("m1", "first", 1), command("m2", "second", 2)]);
				const delivered = yield* Ref.make<ReadonlyArray<string>>([]);
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const pump = yield* makeCloudApiCommandPump({
					fetchCommands: Ref.get(pending).pipe(
						Effect.map((commands) => ({ commands })),
					),
					deliver: (item) =>
						Ref.update(delivered, (items) => [...items, item.messageId]).pipe(
							Effect.andThen(Deferred.succeed(entered, undefined)),
							Effect.andThen(Deferred.await(release)),
							Effect.as(item.turnId),
						),
					ack: (messageId) =>
						Ref.update(pending, (items) =>
							items.filter((item) => item.messageId !== messageId),
						),
				});
				const first = yield* Effect.forkChild(pump.drain, {
					startImmediately: true,
				});
				yield* Deferred.await(entered);
				// Gateway reconnects and nudges may race. They must not queue another
				// delivery behind the in-flight one and start it in the same turn.
				yield* pump.drain;
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(first);
				expect(yield* Ref.get(delivered)).toEqual(["m1"]);

				yield* pump.drain;
				expect(yield* Ref.get(delivered)).toEqual(["m1", "m2"]);
			}),
		);
	});

	it("retains a settlement drain that arrives before the current ack completes", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const pending = yield* Ref.make<
					ReadonlyArray<ReturnType<typeof command>>
				>([command("m1", "first", 1), command("m2", "second", 2)]);
				const delivered = yield* Ref.make<ReadonlyArray<string>>([]);
				const firstEntered = yield* Deferred.make<void>();
				const releaseFirst = yield* Deferred.make<void>();
				const pump = yield* makeCloudApiCommandPump({
					fetchCommands: Ref.get(pending).pipe(
						Effect.map((commands) => ({ commands })),
					),
					deliver: (item) =>
						Ref.update(delivered, (items) => [...items, item.messageId]).pipe(
							Effect.andThen(
								item.messageId === "m1"
									? Deferred.succeed(firstEntered, undefined).pipe(
											Effect.andThen(Deferred.await(releaseFirst)),
										)
									: Effect.void,
							),
							Effect.as(item.turnId),
						),
					ack: (messageId) =>
						Ref.update(pending, (items) =>
							items.filter((item) => item.messageId !== messageId),
						),
				});
				const first = yield* Effect.forkChild(pump.drain, {
					startImmediately: true,
				});
				yield* Deferred.await(firstEntered);
				const afterSettlement = yield* Effect.forkChild(
					pump.drainAfterSettlement("turn:m1"),
					{ startImmediately: true },
				);
				yield* Effect.yieldNow;
				expect(yield* Ref.get(delivered)).toEqual(["m1"]);

				yield* Deferred.succeed(releaseFirst, undefined);
				yield* Fiber.join(first);
				yield* Fiber.join(afterSettlement);
				expect(yield* Ref.get(delivered)).toEqual(["m1", "m2"]);
			}),
		);
	});

	it("repairs a lost ack before advancing beyond the settled turn", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const pending = yield* Ref.make<
					ReadonlyArray<ReturnType<typeof command>>
				>([command("m1", "first", 1), command("m2", "second", 2)]);
				const delivered = yield* Ref.make<ReadonlyArray<string>>([]);
				const ackAttempts = yield* Ref.make(0);
				const pump = yield* makeCloudApiCommandPump({
					fetchCommands: Ref.get(pending).pipe(
						Effect.map((commands) => ({ commands })),
					),
					deliver: (item) =>
						Ref.update(delivered, (items) => [...items, item.messageId]).pipe(
							Effect.as(item.turnId),
						),
					ack: (messageId) =>
						Ref.updateAndGet(ackAttempts, (count) => count + 1).pipe(
							Effect.flatMap((attempt) =>
								attempt === 1
									? Effect.fail("response_lost")
									: Ref.update(pending, (items) =>
											items.filter((item) => item.messageId !== messageId),
										),
							),
						),
				});

				yield* pump.drain;
				yield* pump.drainAfterSettlement("turn:m1");

				expect(yield* Ref.get(delivered)).toEqual(["m1", "m1", "m2"]);
				expect(yield* Ref.get(pending)).toEqual([]);
			}),
		);
	});

	it("swallows fetch failures after bounded retries", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const attempts = yield* Ref.make(0);
				const pump = yield* makeCloudApiCommandPump({
					fetchCommands: Ref.update(attempts, (count) => count + 1).pipe(
						Effect.andThen(Effect.fail("api_503")),
					),
					deliver: () => Effect.succeed("turn-unused"),
					ack: () => Effect.void,
				});
				yield* pump.drain;
				expect(yield* Ref.get(attempts)).toBe(4);
			}),
		);
	});
});

describe("cloud api turn event replay", () => {
	it("serially republishes settled turns with replies from the same turn", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const published = yield* Ref.make<ReadonlyArray<unknown>>([]);
				const drains = yield* Ref.make(0);
				const events = [
					storedEvent(1, {
						_tag: "MessagePersisted",
						messageId: "assistant-turn-1",
						turnId: "turn-1",
						role: "assistant",
						kind: "assistant",
						contentJson: JSON.stringify({
							_tag: "assistant",
							text: "reply for turn one",
						}),
						parentItemId: null,
						createdAt: 1,
					}),
					storedEvent(2, {
						_tag: "MessagePersisted",
						messageId: "assistant-turn-2",
						turnId: "turn-2",
						role: "assistant",
						kind: "assistant",
						contentJson: JSON.stringify({
							_tag: "assistant",
							text: "newer reply from another turn",
						}),
						parentItemId: null,
						createdAt: 2,
					}),
					storedEvent(3, {
						_tag: "TurnSettled",
						turnId: "turn-1",
						outcome: "completed",
						settledAt: 3,
					}),
					storedEvent(4, {
						_tag: "TurnSettled",
						turnId: "turn-tool-only",
						outcome: "error",
						settledAt: 4,
					}),
				];
				const replay = runCloudApiTurnEventStream({
					events: Stream.fromIterable(events),
					publish: (event) =>
						Ref.update(published, (items) => [...items, event]),
					onSettled: () => Ref.update(drains, (count) => count + 1),
				});

				// A fresh runtime starts at sequence zero. Api-side turn idempotency
				// makes replaying the same durable history safe after another restart.
				yield* replay;
				yield* replay;

				expect(yield* Ref.get(published)).toEqual([
					{
						turnId: "turn-1",
						outcome: "completed",
						settledAt: 3,
						replyText: "reply for turn one",
						replyTruncated: false,
					},
					{
						turnId: "turn-tool-only",
						outcome: "error",
						settledAt: 4,
						replyText: "",
						replyTruncated: false,
					},
					{
						turnId: "turn-1",
						outcome: "completed",
						settledAt: 3,
						replyText: "reply for turn one",
						replyTruncated: false,
					},
					{
						turnId: "turn-tool-only",
						outcome: "error",
						settledAt: 4,
						replyText: "",
						replyTruncated: false,
					},
				]);
				expect(yield* Ref.get(drains)).toBe(4);
			}),
		);
	});

	it("caps oversized replies on the durable turn event path", async () => {
		const published: Array<{
			readonly replyText: string;
			readonly replyTruncated: boolean;
		}> = [];
		await Effect.runPromise(
			runCloudApiTurnEventStream({
				events: Stream.fromIterable([
					storedEvent(1, {
						_tag: "MessagePersisted",
						messageId: "assistant-oversized",
						turnId: "turn-oversized",
						role: "assistant",
						kind: "assistant",
						contentJson: JSON.stringify({
							_tag: "assistant",
							text: "x".repeat(CLOUD_RUNTIME_TURN_REPLY_MAX_LENGTH + 10),
						}),
						parentItemId: null,
						createdAt: 1,
					}),
					storedEvent(2, {
						_tag: "TurnSettled",
						turnId: "turn-oversized",
						outcome: "completed",
						settledAt: 2,
					}),
				]),
				publish: (event) =>
					Effect.sync(() => {
						published.push(event);
					}),
				onSettled: () => Effect.void,
			}),
		);

		expect(published).toHaveLength(1);
		expect(published[0]?.replyTruncated).toBe(true);
		expect(published[0]?.replyText).toHaveLength(
			CLOUD_RUNTIME_TURN_REPLY_MAX_LENGTH,
		);
	});
});
