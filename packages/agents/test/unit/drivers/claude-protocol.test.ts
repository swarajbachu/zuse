import { describe, expect, it } from "vitest";

import {
	makeClaudeUserMessage,
	translateClaudeSdkMessages,
} from "../../../src/drivers/claude.ts";

describe("Claude streaming input protocol", () => {
	it("does not expose an application session id as a provider conversation id", () => {
		const message = makeClaudeUserMessage("hello");

		expect(message).not.toHaveProperty("session_id");
	});
});

describe("Claude partial-message durability", () => {
	it("emits cumulative stable checkpoints and a final promotion", () => {
		const events = translateClaudeSdkMessages([
			{
				type: "stream_event",
				event: {
					type: "message_start",
					message: { id: "message-1" },
				},
				parent_tool_use_id: null,
			},
			{
				type: "stream_event",
				event: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				},
				parent_tool_use_id: null,
			},
			{
				type: "stream_event",
				event: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "Hello " },
				},
				parent_tool_use_id: null,
			},
			{
				type: "stream_event",
				event: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "world" },
				},
				parent_tool_use_id: null,
			},
			{
				type: "stream_event",
				event: { type: "content_block_stop", index: 0 },
				parent_tool_use_id: null,
			},
		] as never);

		expect(events).toMatchObject([
			{
				_tag: "AssistantMessage",
				itemId: "message-1:text:0",
				text: "Hello ",
				checkpoint: { revision: 1, final: false },
			},
			{
				_tag: "AssistantMessage",
				itemId: "message-1:text:0",
				text: "Hello world",
				checkpoint: { revision: 2, final: false },
			},
			{
				_tag: "AssistantMessage",
				itemId: "message-1:text:0",
				text: "Hello world",
				checkpoint: { revision: 3, final: true },
			},
		]);
	});

	it("does not append the completed assistant snapshot after streamed text", () => {
		const streamMessages = [
			{
				type: "stream_event",
				event: {
					type: "message_start",
					message: { id: "message-1" },
				},
				parent_tool_use_id: null,
			},
			{
				type: "stream_event",
				event: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				},
				parent_tool_use_id: null,
			},
			{
				type: "stream_event",
				event: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "done" },
				},
				parent_tool_use_id: null,
			},
			{
				type: "stream_event",
				event: { type: "content_block_stop", index: 0 },
				parent_tool_use_id: null,
			},
			{
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
				},
				parent_tool_use_id: null,
			},
		] as never;

		const events = translateClaudeSdkMessages(streamMessages).filter(
			(event) => event._tag === "AssistantMessage",
		);
		expect(events).toHaveLength(2);
		expect(events.at(-1)?.checkpoint?.final).toBe(true);
	});
});
