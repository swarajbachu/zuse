import type { SDKMessage } from "@cursor/sdk";
import { describe, expect, it } from "vitest";

import {
	type CursorSdkTranslationState,
	flushCursorSdkMessages,
	normalizeCursorMcpServers,
	translateCursorSdkMessage,
} from "../../../src/drivers/cursor.ts";

const state = (): CursorSdkTranslationState => ({
	seenToolCalls: new Set(),
	messageSequence: 0,
	thinkingSequence: 0,
	assistantBuffer: null,
	thinkingBuffer: null,
	model: "composer-2",
});

const translate = (message: SDKMessage, current = state()) =>
	translateCursorSdkMessage(message, current);

const eventItemId = (event: { readonly _tag: string } | undefined) =>
	event !== undefined && "itemId" in event ? event.itemId : undefined;

describe("bundled provider SDK translation", () => {
	it("translates initialization and streamed content", () => {
		const current = state();
		expect(
			translate(
				{
					type: "system",
					agent_id: "agent-1",
					run_id: "run-1",
					tools: ["read", "write"],
				},
				current,
			),
		).toEqual([
			{ _tag: "Auth", sdkConfigured: true },
			{ _tag: "Capabilities", capabilities: ["read", "write"] },
		]);

		expect(
			translate(
				{
					type: "assistant",
					agent_id: "agent-1",
					run_id: "run-1",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Hi" }],
					},
				},
				current,
			),
		).toEqual([
			expect.objectContaining({ _tag: "AssistantMessage", text: "Hi" }),
		]);

		expect(
			translate(
				{
					type: "thinking",
					agent_id: "agent-1",
					run_id: "run-1",
					text: "Checking",
				},
				current,
			)[0],
		).toMatchObject({ _tag: "Thinking", text: "Checking" });

		const statusEvents = translate(
			{
				type: "status",
				agent_id: "agent-1",
				run_id: "run-1",
				status: "FINISHED",
			},
			current,
		);
		expect(statusEvents).toEqual([{ _tag: "Status", status: "idle" }]);
	});

	it("translates usage", () => {
		expect(
			translate({
				type: "usage",
				agent_id: "agent-1",
				run_id: "run-1",
				usage: {
					inputTokens: 10,
					outputTokens: 5,
					cacheReadTokens: 2,
					cacheWriteTokens: 1,
					totalTokens: 15,
				},
			})[0],
		).toMatchObject({
			_tag: "UsageDelta",
			inputTokens: 10,
			outputTokens: 5,
			model: "composer-2",
		});
	});

	it("coalesces adjacent thinking and assistant deltas into logical messages", () => {
		const current = state();
		const thinking = (text: string): SDKMessage => ({
			type: "thinking",
			agent_id: "agent-1",
			run_id: "run-1",
			text,
		});
		const assistant = (text: string): SDKMessage => ({
			type: "assistant",
			agent_id: "agent-1",
			run_id: "run-1",
			message: { role: "assistant", content: [{ type: "text", text }] },
		});

		const [firstThinking] = translate(
			thinking("The user sent a casual"),
			current,
		);
		expect(firstThinking).toMatchObject({
			_tag: "Thinking",
			text: "The user sent a casual",
		});
		expect(
			translate(
				{
					type: "status",
					agent_id: "agent-1",
					run_id: "run-1",
					status: "RUNNING",
				},
				current,
			),
		).toEqual([{ _tag: "Status", status: "running" }]);
		const [secondThinking] = translate(thinking(" greeting."), current);
		expect(secondThinking).toMatchObject({
			_tag: "Thinking",
			itemId: eventItemId(firstThinking),
			text: "The user sent a casual greeting.",
		});
		const [firstAssistant] = translate(assistant("Hey — what"), current);
		expect(firstAssistant).toMatchObject({
			_tag: "AssistantMessage",
			text: "Hey — what",
		});
		const [secondAssistant] = translate(
			assistant(" do you want to work on?"),
			current,
		);
		expect(secondAssistant).toMatchObject({
			_tag: "AssistantMessage",
			itemId: eventItemId(firstAssistant),
			text: "Hey — what do you want to work on?",
		});
		expect(flushCursorSdkMessages(current)).toEqual([]);

		const tokenSplit = state();
		const [firstToken] = translate(assistant("pack"), tokenSplit);
		const [secondToken] = translate(assistant("age.json"), tokenSplit);
		expect(firstToken).toMatchObject({
			_tag: "AssistantMessage",
			text: "pack",
		});
		expect(secondToken).toMatchObject({
			_tag: "AssistantMessage",
			itemId: eventItemId(firstToken),
			text: "package.json",
		});
	});

	it("deduplicates tool starts and makes blocked results actionable", () => {
		const current = state();
		const start: SDKMessage = {
			type: "tool_call",
			agent_id: "agent-1",
			run_id: "run-1",
			call_id: "call-1",
			name: "shell",
			status: "running",
			args: { command: "git status" },
		};
		expect(translate(start, current)).toHaveLength(1);
		expect(translate(start, current)).toEqual([]);

		const [blocked] = translate(
			{ ...start, status: "error", result: "Denied by classifier" },
			current,
		);
		expect(blocked).toMatchObject({ _tag: "ToolResult", isError: true });
		expect(blocked?._tag === "ToolResult" ? blocked.output : "").toContain(
			"not retried",
		);

		const ordinaryError = translate(
			{
				...start,
				call_id: "call-2",
				status: "error",
				result: "Process timed out",
			},
			current,
		).find((event) => event._tag === "ToolResult");
		expect(
			ordinaryError?._tag === "ToolResult" ? ordinaryError.output : "",
		).toBe("Process timed out");
	});

	it("normalizes SDK file reads into the shared file-read contract", () => {
		const current = state();
		const start: SDKMessage = {
			type: "tool_call",
			agent_id: "agent-1",
			run_id: "run-1",
			call_id: "read-1",
			name: "read_file",
			status: "running",
			args: { path: "/workspace/package.json" },
		};

		expect(translate(start, current)).toEqual([
			{
				_tag: "ToolUse",
				itemId: "read-1",
				tool: "Read",
				input: { file_path: "/workspace/package.json" },
			},
		]);
		expect(
			translate(
				{
					...start,
					status: "completed",
					result: {
						status: "success",
						value: {
							content: '{\n  "name": "zuse"\n}',
							totalLines: 3,
							fileSize: 24,
						},
					},
				},
				current,
			),
		).toEqual([
			{
				_tag: "ToolResult",
				itemId: "read-1",
				output: '{\n  "name": "zuse"\n}',
				isError: false,
			},
		]);
	});

	it("normalizes stdio and remote MCP configurations", () => {
		expect(
			normalizeCursorMcpServers([
				{ name: "local", command: "node", args: ["server.js"] },
				{ id: "remote", url: "https://example.test/mcp", headers: { A: "B" } },
			]),
		).toEqual({
			local: { type: "stdio", command: "node", args: ["server.js"] },
			remote: {
				type: "http",
				url: "https://example.test/mcp",
				headers: { A: "B" },
			},
		});
	});
});
