import { type Message, MessageId, SessionId } from "@zuse/contracts";
import { Schema } from "effect";
import { describe, expect, test } from "vitest";

import { messageKey, sanitizeMessages } from "../../../src/lib/message-safety";

describe("mobile message safety", () => {
	test("keeps known renderable messages", () => {
		const sessionId = Schema.decodeUnknownSync(SessionId)("session-1");
		const messages = [
			{
				id: Schema.decodeUnknownSync(MessageId)("msg-1"),
				sessionId,
				role: "assistant",
				content: { _tag: "assistant", text: "hello" },
				createdAt: new Date(),
			},
			{
				id: Schema.decodeUnknownSync(MessageId)("msg-2"),
				sessionId,
				role: "assistant",
				content: {
					_tag: "usage_limit",
					providerId: "gemini",
					label: "Limit reached",
					usedPercent: null,
					resetsAt: null,
					windowMinutes: null,
				},
				createdAt: new Date(),
			},
		] satisfies ReadonlyArray<Message>;

		expect(sanitizeMessages(messages).map((message) => message.id)).toEqual([
			"msg-1",
			"msg-2",
		]);
	});

	test("drops malformed rows before chat render logic", () => {
		const messages = [
			{
				id: "msg-good",
				sessionId: "session-1",
				role: "assistant",
				content: { _tag: "assistant", text: "ok" },
				createdAt: new Date(),
			},
			{
				id: "msg-bad",
				sessionId: "session-1",
				role: "assistant",
				content: { _tag: "assistant", text: { nested: true } },
				createdAt: new Date(),
			},
			{
				id: "",
				sessionId: "session-1",
				role: "assistant",
				content: { _tag: "error", message: "bad id" },
				createdAt: new Date(),
			},
			{
				id: "msg-unknown",
				sessionId: "session-1",
				role: "assistant",
				content: { _tag: "future_tag", value: "later" },
				createdAt: new Date(),
			},
		] as unknown as readonly Message[];

		expect(sanitizeMessages(messages).map((message) => message.id)).toEqual([
			"msg-good",
		]);
	});

	test("falls back to stable list key when needed", () => {
		const message = { id: "" } as Message;
		expect(messageKey(message, 3)).toBe("message-3");
	});
});
