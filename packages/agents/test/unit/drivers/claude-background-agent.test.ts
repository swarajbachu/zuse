import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { translateClaudeSdkMessages } from "@zuse/agents/drivers/claude";
import { describe, expect, it } from "vitest";

const sdk = (value: unknown): SDKMessage => value as SDKMessage;

describe("Claude background agents", () => {
	it("normalizes structured task lifecycle events as one detached run", () => {
		const events = translateClaudeSdkMessages([
			sdk({
				type: "assistant",
				parent_tool_use_id: null,
				message: {
					content: [
						{
							type: "tool_use",
							id: "agent-tool-1",
							name: "Agent",
							input: {
								prompt: "Audit retention behavior",
								subagent_type: "researcher",
								run_in_background: true,
							},
						},
					],
				},
			}),
			sdk({
				type: "user",
				parent_tool_use_id: null,
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "agent-tool-1",
							content: "Background task launched",
							is_error: false,
						},
					],
				},
			}),
			sdk({
				type: "system",
				subtype: "task_started",
				task_id: "background-task-1",
				tool_use_id: "agent-tool-1",
				description: "Audit retention behavior",
				task_type: "researcher",
				prompt: "Audit retention behavior",
			}),
			sdk({
				type: "system",
				subtype: "task_progress",
				task_id: "background-task-1",
				tool_use_id: "agent-tool-1",
				description: "Reading retention stores",
				usage: { total_tokens: 40, tool_uses: 2, duration_ms: 500 },
			}),
			sdk({
				type: "system",
				subtype: "task_notification",
				task_id: "background-task-1",
				tool_use_id: "agent-tool-1",
				status: "completed",
				output_file: "/private/internal/transcript.jsonl",
				summary: "Retention audit complete",
				usage: { total_tokens: 80, tool_uses: 4, duration_ms: 1200 },
			}),
		]);

		const detached = events.find(
			(event) => event._tag === "ToolUse" && event.subagent !== undefined,
		);
		expect(detached).toMatchObject({
			_tag: "ToolUse",
			itemId: "agent-tool-1",
			subagent: {
				childSessionId: "background-task-1",
				presentation: "detached",
			},
		});

		expect(events.filter((event) => event._tag === "SubagentSummary")).toEqual([
			expect.objectContaining({
				itemId: "agent-tool-1",
				childSessionId: "background-task-1",
				presentation: "detached",
				summary: "Retention audit complete",
				isError: false,
				durationMs: 1200,
			}),
		]);
		expect(
			events.filter(
				(event) =>
					event._tag === "AssistantMessage" &&
					event.parentItemId === "agent-tool-1",
			),
		).toHaveLength(2);
	});
});
