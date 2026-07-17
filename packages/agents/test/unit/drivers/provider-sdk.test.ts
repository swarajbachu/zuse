import type { SDKMessage } from "@cursor/sdk";
import { describe, expect, it } from "vitest";

import {
	type CursorSdkTranslationState,
	normalizeCursorMcpServers,
	translateCursorSdkMessage,
} from "../../../src/drivers/cursor.ts";

const state = (): CursorSdkTranslationState => ({
	seenToolCalls: new Set(),
	messageSequence: 0,
	thinkingSequence: 0,
	model: "composer-2",
});

const translate = (message: SDKMessage, current = state()) =>
	translateCursorSdkMessage(message, current);

describe("bundled provider SDK translation", () => {
	it("translates initialization and streamed content", () => {
		expect(
			translate({
				type: "system",
				agent_id: "agent-1",
				run_id: "run-1",
				tools: ["read", "write"],
			}),
		).toEqual([
			{ _tag: "Auth", sdkConfigured: true },
			{ _tag: "Capabilities", capabilities: ["read", "write"] },
		]);

		expect(
			translate({
				type: "assistant",
				agent_id: "agent-1",
				run_id: "run-1",
				message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
			})[0],
		).toMatchObject({ _tag: "AssistantMessage", text: "Hi" });

		expect(
			translate({
				type: "thinking",
				agent_id: "agent-1",
				run_id: "run-1",
				text: "Checking",
			})[0],
		).toMatchObject({ _tag: "Thinking", text: "Checking" });

		expect(
			translate({
				type: "status",
				agent_id: "agent-1",
				run_id: "run-1",
				status: "RUNNING",
			}),
		).toEqual([{ _tag: "Status", status: "running" }]);
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
			{ ...start, call_id: "call-2", status: "error", result: "Process timed out" },
			current,
		).find((event) => event._tag === "ToolResult");
		expect(
			ordinaryError?._tag === "ToolResult" ? ordinaryError.output : "",
		).toBe("Process timed out");
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
