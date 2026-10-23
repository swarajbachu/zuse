import { describe, expect, it } from "vitest";

import {
	CLAUDE_READ_ONLY_DISALLOWED_TOOLS,
	claudeReadOnlyToolAllowed,
	claudeToolPermissionPolicy,
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

describe("Claude streamed usage windows", () => {
	it("keeps model windows separate and converts fraction units explicitly", () => {
		const events = translateClaudeSdkMessages([
			{
				type: "rate_limit_event",
				rate_limit_info: {
					rateLimitType: "seven_day_opus",
					utilization: 0.005,
					resetsAt: 1800000000,
				},
			},
		] as never);
		expect(events).toMatchObject([
			{
				_tag: "UsageLimit",
				id: "seven_day_opus",
				scope: "model",
				label: "Opus only",
				usedPercent: 0.5,
			},
		]);
	});
});

it.each([
	"html_preview",
	"html_render",
])("applies the normal approval policy to %s", (tool) => {
	expect(
		claudeToolPermissionPolicy(`mcp__zuse__${tool}`, {}, "approval-required")
			.kind,
	).toBe("prompt");
	expect(
		claudeToolPermissionPolicy(`mcp__zuse__${tool}`, {}, "full-access").kind,
	).toBe("auto-allow");
});

it.each([
	"orchestrator_capabilities",
	"task_status",
	"list_scheduled_tasks",
	"wait_for_thread",
])("auto-allows shared orchestration read %s", (tool) => {
	expect(
		claudeToolPermissionPolicy(`mcp__zuse__${tool}`, {}, "approval-required")
			.kind,
	).toBe("auto-allow");
});
it.each([
	"delegate_task",
	"task_cancel",
	"schedule_task",
])("keeps orchestration mutation %s permission-gated", (tool) => {
	expect(
		claudeToolPermissionPolicy(`mcp__zuse__${tool}`, {}, "approval-required")
			.kind,
	).toBe("prompt");
});

describe("Claude read-only sessions", () => {
	const sessionTools = new Set(["mcp__zuse__guide_file_diff"]);

	it.each(["Read", "Glob", "Grep", "LS"])("allows %s", (tool) => {
		expect(
			claudeReadOnlyToolAllowed(tool, { file_path: "src/a.ts" }, sessionTools),
		).toBe(true);
	});

	it("allows the session's own tools and no other app tools", () => {
		expect(
			claudeReadOnlyToolAllowed("mcp__zuse__guide_file_diff", {}, sessionTools),
		).toBe(true);
		expect(
			claudeReadOnlyToolAllowed(
				"mcp__zuse__browser_navigate",
				{},
				sessionTools,
			),
		).toBe(false);
	});

	it.each(CLAUDE_READ_ONLY_DISALLOWED_TOOLS)("denies %s", (tool) => {
		expect(claudeReadOnlyToolAllowed(tool, {}, sessionTools)).toBe(false);
	});

	it("denies reads of sensitive paths instead of prompting", () => {
		expect(
			claudeReadOnlyToolAllowed("Read", { file_path: ".env" }, sessionTools),
		).toBe(false);
	});
});
