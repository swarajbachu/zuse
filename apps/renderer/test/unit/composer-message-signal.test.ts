import {
	AgentItemId,
	Message,
	type MessageContent,
	MessageId,
	type SessionId,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import { makeComposerMessageSignalSelector } from "../../src/lib/composer-message-signal.ts";

const sessionId = "composer-signal-session" as SessionId;
const message = (id: string, content: MessageContent): Message =>
	Message.make({
		id: MessageId.make(id),
		sessionId,
		role: "assistant",
		content,
		createdAt: new Date(0),
	});

describe("composer message signal", () => {
	it("preserves identity while ordinary agent output streams", () => {
		const selectComposerMessageSignal =
			makeComposerMessageSignalSelector(sessionId);
		const question = message("question", {
			_tag: "user_question",
			itemId: AgentItemId.make("question-item"),
			questions: [],
		});
		const first = selectComposerMessageSignal({ [sessionId]: [question] });
		const streamed = selectComposerMessageSignal({
			[sessionId]: [
				question,
				message("thinking", {
					_tag: "thinking",
					itemId: AgentItemId.make("thinking-item"),
					text: "working",
					redacted: false,
				}),
				message("assistant", { _tag: "assistant", text: "partial" }),
			],
		});

		expect(streamed).toBe(first);
	});

	it("changes identity for interactions that take over the composer", () => {
		const selectComposerMessageSignal =
			makeComposerMessageSignalSelector(sessionId);
		const first = selectComposerMessageSignal({ [sessionId]: [] });
		const next = selectComposerMessageSignal({
			[sessionId]: [
				message("plan", {
					_tag: "tool_use",
					itemId: AgentItemId.make("plan-item"),
					tool: "ExitPlanMode",
					input: { plan: "Do the work" },
				}),
			],
		});

		expect(next).not.toBe(first);
		expect(next).toHaveLength(1);
	});
});
