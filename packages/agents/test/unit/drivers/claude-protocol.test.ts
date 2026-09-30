import { describe, expect, it } from "vitest";

import {
	makeClaudeUserMessage,
	runtimeModeToSdkPermissionMode,
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

	// Claude Code 2.1.283+ delivers one completed `assistant` snapshot per
	// content block, before that block's `content_block_stop`.
	it("emits each streamed block once when the snapshot precedes content_block_stop", () => {
		const stream = (event: Record<string, unknown>) => ({
			type: "stream_event",
			event,
			parent_tool_use_id: null,
		});
		const snapshot = (content: unknown[]) => ({
			type: "assistant",
			message: { id: "message-1", role: "assistant", content },
			parent_tool_use_id: null,
		});
		const events = translateClaudeSdkMessages([
			stream({ type: "message_start", message: { id: "message-1" } }),
			stream({
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "" },
			}),
			stream({
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: "pondering" },
			}),
			snapshot([{ type: "thinking", thinking: "pondering" }]),
			stream({ type: "content_block_stop", index: 0 }),
			stream({
				type: "content_block_start",
				index: 1,
				content_block: { type: "text", text: "" },
			}),
			stream({
				type: "content_block_delta",
				index: 1,
				delta: { type: "text_delta", text: "answer" },
			}),
			snapshot([{ type: "text", text: "answer" }]),
			stream({ type: "content_block_stop", index: 1 }),
			stream({
				type: "content_block_start",
				index: 2,
				content_block: { type: "tool_use", id: "tool-1", name: "Bash" },
			}),
			snapshot([
				{
					type: "tool_use",
					id: "tool-1",
					name: "Bash",
					input: { command: "echo hi" },
				},
			]),
			stream({ type: "content_block_stop", index: 2 }),
		] as never);

		const rows = events.filter(
			(event) =>
				event._tag === "Thinking" ||
				event._tag === "AssistantMessage" ||
				event._tag === "ToolUse",
		);
		expect(new Set(rows.map((event) => event.itemId))).toEqual(
			new Set(["message-1:thinking:0", "message-1:text:1", "tool-1"]),
		);
		expect(rows).toMatchObject([
			{ _tag: "Thinking", checkpoint: { final: false } },
			{
				_tag: "Thinking",
				text: "pondering",
				checkpoint: { final: true },
			},
			{ _tag: "AssistantMessage", checkpoint: { final: false } },
			{
				_tag: "AssistantMessage",
				text: "answer",
				checkpoint: { final: true },
			},
			{ _tag: "ToolUse", itemId: "tool-1" },
		]);
		expect(rows[1]?.itemId).toBe(rows[0]?.itemId);
		expect(rows[3]?.itemId).toBe(rows[2]?.itemId);
	});

	it("reuses text row IDs when an unstreamed snapshot is replayed", () => {
		const snapshot = (id: string) => ({
			type: "assistant",
			message: {
				id,
				role: "assistant",
				content: [
					{ type: "text", text: "first" },
					{ type: "text", text: "second" },
				],
			},
			parent_tool_use_id: null,
		});
		const events = translateClaudeSdkMessages([
			snapshot("message-1"),
			snapshot("message-1"),
			snapshot("message-2"),
		] as never);

		expect(events).toMatchObject([
			{ _tag: "AssistantMessage", itemId: "message-1:text:0", text: "first" },
			{ _tag: "AssistantMessage", itemId: "message-1:text:1", text: "second" },
			{ _tag: "AssistantMessage", itemId: "message-1:text:0", text: "first" },
			{ _tag: "AssistantMessage", itemId: "message-1:text:1", text: "second" },
			{ _tag: "AssistantMessage", itemId: "message-2:text:0", text: "first" },
			{ _tag: "AssistantMessage", itemId: "message-2:text:1", text: "second" },
		]);
	});

	it("generates distinct text row IDs when snapshots have no message ID", () => {
		const snapshot = {
			type: "assistant",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "reply" }],
			},
			parent_tool_use_id: null,
		};
		const events = translateClaudeSdkMessages([snapshot, snapshot] as never);

		expect(events).toMatchObject([
			{ _tag: "AssistantMessage", itemId: expect.any(String), text: "reply" },
			{ _tag: "AssistantMessage", itemId: expect.any(String), text: "reply" },
		]);
		const rows = events.filter((event) => event._tag === "AssistantMessage");
		expect(rows[0]?.itemId).not.toBe(rows[1]?.itemId);
	});

	it("still emits text and thinking from snapshots that never streamed", () => {
		const events = translateClaudeSdkMessages([
			{
				type: "assistant",
				message: {
					id: "message-2",
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "hmm" },
						{ type: "text", text: "reply" },
					],
				},
				parent_tool_use_id: "agent-1",
			},
		] as never);

		expect(events).toMatchObject([
			{ _tag: "Thinking", text: "hmm", parentItemId: "agent-1" },
			{ _tag: "AssistantMessage", text: "reply", parentItemId: "agent-1" },
		]);
	});
});

describe("Claude native access modes", () => {
	it("delegates automatic review to the SDK instead of bypassing permissions", () => {
		expect(runtimeModeToSdkPermissionMode("auto", "default")).toBe("auto");
		expect(runtimeModeToSdkPermissionMode("approval-required", "default")).toBe(
			"default",
		);
		expect(runtimeModeToSdkPermissionMode("full-access", "default")).toBe(
			"bypassPermissions",
		);
	});
	it("preserves read-only planning in every new access mode", () => {
		for (const mode of ["approval-required", "auto", "full-access"] as const) {
			expect(runtimeModeToSdkPermissionMode(mode, "plan")).toBe("plan");
		}
	});
});
