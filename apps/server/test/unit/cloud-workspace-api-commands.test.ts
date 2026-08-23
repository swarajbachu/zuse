import {
	CLOUD_RUNTIME_TURN_REPLY_MAX_LENGTH,
	Message,
	MessageId,
	SessionId,
} from "@zuse/contracts";
import { Effect, Ref } from "effect";
import { describe, expect, it } from "vitest";
import {
	cloudTurnReplyExcerpt,
	makeCloudApiCommandPump,
} from "../../src/api/cloud-workspace-api-commands.ts";

const command = (messageId: string, text: string) => ({
	messageId,
	commandId: `api:${messageId}`,
	sessionId: "session-1",
	text,
	seq: 1,
});

const assistantMessage = (id: string, text: string): Message =>
	Message.make({
		id: MessageId.make(id),
		sessionId: SessionId.make("session-1"),
		role: "assistant",
		content: { _tag: "assistant", text },
		createdAt: new Date(0),
	});

const userMessage = (id: string, text: string): Message =>
	Message.make({
		id: MessageId.make(id),
		sessionId: SessionId.make("session-1"),
		role: "user",
		content: { _tag: "user", text },
		createdAt: new Date(0),
	});

describe("cloud api command pump", () => {
	it("delivers and acks each fetched command exactly once per drain", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const delivered = yield* Ref.make<ReadonlyArray<string>>([]);
				const acked = yield* Ref.make<ReadonlyArray<string>>([]);
				const pump = yield* makeCloudApiCommandPump({
					fetchCommands: Effect.succeed({
						commands: [command("m1", "first"), command("m2", "second")],
					}),
					deliver: (item) =>
						Ref.update(delivered, (items) => [...items, item.commandId]),
					ack: (messageId) =>
						Ref.update(acked, (items) => [...items, messageId]),
				});
				yield* pump.drain;
				expect(yield* Ref.get(delivered)).toEqual(["api:m1", "api:m2"]);
				expect(yield* Ref.get(acked)).toEqual(["m1", "m2"]);
			}),
		);
	});

	it("keeps a failed delivery un-acked so redelivery can retry it", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const acked = yield* Ref.make<ReadonlyArray<string>>([]);
				const pump = yield* makeCloudApiCommandPump({
					fetchCommands: Effect.succeed({
						commands: [command("bad", "boom"), command("good", "ok")],
					}),
					deliver: (item) =>
						item.messageId === "bad"
							? Effect.fail("session_missing")
							: Effect.void,
					ack: (messageId) =>
						Ref.update(acked, (items) => [...items, messageId]),
				});
				yield* pump.drain;
				expect(yield* Ref.get(acked)).toEqual(["good"]);
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
					deliver: () => Effect.void,
					ack: () => Effect.void,
				});
				yield* pump.drain;
				expect(yield* Ref.get(attempts)).toBe(4);
			}),
		);
	});
});

describe("cloudTurnReplyExcerpt", () => {
	it("returns the final assistant text", () => {
		const excerpt = cloudTurnReplyExcerpt([
			userMessage("m1", "do the thing"),
			assistantMessage("m2", "working on it"),
			assistantMessage("m3", "all done"),
		]);
		expect(excerpt).toEqual({ text: "all done", truncated: false });
	});

	it("is empty for tool-only turns", () => {
		expect(cloudTurnReplyExcerpt([userMessage("m1", "hi")])).toEqual({
			text: "",
			truncated: false,
		});
	});

	it("caps oversized replies and flags truncation", () => {
		const excerpt = cloudTurnReplyExcerpt([
			assistantMessage(
				"m1",
				"x".repeat(CLOUD_RUNTIME_TURN_REPLY_MAX_LENGTH + 10),
			),
		]);
		expect(excerpt.truncated).toBe(true);
		expect(excerpt.text).toHaveLength(CLOUD_RUNTIME_TURN_REPLY_MAX_LENGTH);
	});
});
