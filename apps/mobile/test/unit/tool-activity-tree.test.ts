import { Message, MessageId, SessionId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	segmentTurnBody,
	toolTreePositions,
} from "../../src/lib/tool-activity-tree";

const sessionId = SessionId.make("session-1");
const message = (id: string, content: Message["content"]): Message =>
	Message.make({
		id: MessageId.make(id),
		sessionId,
		role: "assistant",
		content,
		createdAt: new Date(0),
	});
const tool = (id: string) =>
	message(id, {
		_tag: "tool_use",
		itemId: `item-${id}` as never,
		tool: "Read",
		input: {},
	});
const text = (id: string, value = "Done") =>
	message(id, { _tag: "assistant", text: value });
const thinking = (id: string) =>
	message(id, {
		_tag: "thinking",
		itemId: `item-${id}` as never,
		text: "…",
		redacted: false,
	});
const result = (id: string) =>
	message(id, {
		_tag: "tool_result",
		itemId: `item-${id}` as never,
		output: "",
		isError: false,
	} as never);

describe("tool activity tree", () => {
	it("ends the trunk at the last branch and carries it through other rows", () => {
		const positions = toolTreePositions([
			thinking("a"),
			tool("b"),
			result("c"),
			tool("d"),
			result("e"),
		]);
		expect([...positions.values()]).toEqual([
			"branch",
			"branch",
			"through",
			"last",
			null,
		]);
	});

	it("groups consecutive tool activity between narrative rows", () => {
		const segments = segmentTurnBody([
			thinking("a"),
			tool("b"),
			text("empty", " "),
			tool("c"),
			text("d"),
			tool("e"),
		]);
		expect(
			segments.map((segment) =>
				segment.kind === "activity"
					? `${segment.id}:${segment.toolCount}:${segment.messages.length}`
					: segment.message.id,
			),
		).toEqual(["tools:a:2:4", "d", "tools:e:1:1"]);
	});

	it("leaves reasoning without tool calls as plain rows", () => {
		const segments = segmentTurnBody([thinking("a"), text("b")]);
		expect(segments.map((segment) => segment.kind)).toEqual([
			"message",
			"message",
		]);
	});
});
