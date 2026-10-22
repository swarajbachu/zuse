import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { translateClaudeSdkMessages } from "@zuse/agents/drivers/claude";
import { describe, expect, it } from "vitest";

const sdk = (value: unknown): SDKMessage => value as SDKMessage;

describe("Claude background agents", () => {
	it("settles a rejected workflow launch instead of leaving it running", () => {
		const events = translateClaudeSdkMessages([
			sdk({
				type: "assistant",
				parent_tool_use_id: null,
				message: {
					content: [
						{
							type: "tool_use",
							id: "rejected-workflow",
							name: "Workflow",
							input: { name: "audit" },
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
							tool_use_id: "rejected-workflow",
							content: "Invalid workflow script",
							is_error: true,
						},
					],
				},
			}),
		]);
		expect(events).toContainEqual(
			expect.objectContaining({
				_tag: "SubagentSummary",
				itemId: "rejected-workflow",
				isError: true,
				summary: "Invalid workflow script",
			}),
		);
	});

	it("updates a running workflow with its phase and agent snapshot", () => {
		const input = { script: "export const meta = { name: 'audit' };" };
		let tick = 0;
		const progress = (state: string, extra: Record<string, unknown> = {}) => {
			tick += 1;
			return sdk({
				type: "system",
				subtype: "task_progress",
				task_id: "task-1",
				tool_use_id: "workflow-1",
				description: "Map: map:files",
				usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 },
				workflow_progress: [
					{ type: "workflow_phase", index: 1, title: "Map", kind: undefined },
					{
						type: "workflow_agent",
						index: 1,
						label: "map:files",
						phaseIndex: 1,
						phaseTitle: "Map",
						state,
						startedAt: 100,
						promptPreview: "List files",
						lastProgressAt: tick,
						tokens: tick * 10,
						...extra,
					},
					{ type: "workflow_log", message: "ignored" },
				],
			});
		};
		const events = translateClaudeSdkMessages([
			sdk({
				type: "assistant",
				parent_tool_use_id: null,
				message: {
					content: [
						{ type: "tool_use", id: "workflow-1", name: "Workflow", input },
					],
				},
			}),
			sdk({
				type: "system",
				subtype: "task_started",
				task_id: "task-1",
				tool_use_id: "workflow-1",
				task_type: "local_workflow",
				workflow_name: "audit",
				description: "Audit",
			}),
			progress("progress"),
			progress("progress"),
			progress("done", { durationMs: 40, resultPreview: "3 files" }),
		]);
		const updates = events.filter(
			(event) =>
				event._tag === "ToolUse" &&
				typeof event.input === "object" &&
				event.input !== null &&
				"workflow_progress" in event.input,
		);
		expect(updates).toHaveLength(2);
		expect(updates[0]).toMatchObject({
			itemId: "workflow-1",
			tool: "Workflow",
			subagent: { childSessionId: "task-1", presentation: "detached" },
			input: {
				...input,
				workflow_name: "audit",
				workflow_progress: {
					phases: [{ index: 1, title: "Map" }],
					agents: [
						{
							index: 1,
							label: "map:files",
							phaseIndex: 1,
							phaseTitle: "Map",
							state: "running",
							startedAt: 100,
							promptPreview: "List files",
						},
					],
				},
			},
		});
		expect(updates[1]).toMatchObject({
			input: {
				workflow_progress: {
					agents: [{ state: "done", durationMs: 40, resultPreview: "3 files" }],
				},
			},
		});
	});

	it("preserves native workflow identity and source through background completion", () => {
		const input = {
			script: "export const meta = { name: 'audit', phases: [] };",
			resumeFromRunId: "prior-run",
		};
		const events = translateClaudeSdkMessages([
			sdk({
				type: "assistant",
				parent_tool_use_id: null,
				message: {
					content: [
						{ type: "tool_use", id: "workflow-1", name: "Workflow", input },
					],
				},
			}),
			sdk({
				type: "system",
				subtype: "task_started",
				task_id: "run-1",
				tool_use_id: "workflow-1",
				task_type: "local_workflow",
				workflow_name: "audit",
				description: "Audit the project",
			}),
			sdk({
				type: "system",
				subtype: "task_notification",
				task_id: "run-1",
				status: "failed",
				summary: "Build failed",
				usage: { duration_ms: 2000, total_tokens: 1, tool_uses: 1 },
			}),
		]);
		expect(events.filter((event) => event._tag === "ToolUse")).toEqual([
			expect.objectContaining({ tool: "Workflow", input }),
			expect.objectContaining({
				tool: "Workflow",
				itemId: "workflow-1",
				input: expect.objectContaining({ ...input, workflow_name: "audit" }),
				subagent: { childSessionId: "run-1", presentation: "detached" },
			}),
		]);
		expect(events).toContainEqual(
			expect.objectContaining({
				_tag: "SubagentSummary",
				itemId: "workflow-1",
				agentName: "audit",
				isError: true,
				durationMs: 2000,
			}),
		);
	});

	it("keeps local background shell tasks out of the subagent lifecycle", () => {
		const events = translateClaudeSdkMessages([
			sdk({
				type: "assistant",
				parent_tool_use_id: null,
				message: {
					content: [
						{
							type: "tool_use",
							id: "background-shell-1",
							name: "Bash",
							input: { command: "npm run dev", run_in_background: true },
						},
					],
				},
			}),
			sdk({
				type: "system",
				subtype: "task_started",
				task_id: "background-task-1",
				tool_use_id: "background-shell-1",
				description: "Restart dev server",
				task_type: "local_bash",
				prompt: "Restart dev server",
				skip_transcript: true,
			}),
			sdk({
				type: "system",
				subtype: "task_progress",
				task_id: "background-task-1",
				tool_use_id: "background-shell-1",
				description: "Waiting for dev server",
				usage: { total_tokens: 0, tool_uses: 1, duration_ms: 500 },
			}),
			sdk({
				type: "system",
				subtype: "task_notification",
				task_id: "background-task-1",
				tool_use_id: "background-shell-1",
				status: "completed",
				output_file: "/private/internal/output.txt",
				summary: "Dev server is ready",
				usage: { total_tokens: 0, tool_uses: 1, duration_ms: 1200 },
				skip_transcript: true,
			}),
			sdk({
				type: "user",
				parent_tool_use_id: null,
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "background-shell-1",
							content: "Dev server is ready",
							is_error: false,
						},
					],
				},
			}),
		]);

		expect(events.filter((event) => event._tag === "ToolUse")).toEqual([
			expect.objectContaining({
				_tag: "ToolUse",
				itemId: "background-shell-1",
				tool: "Bash",
			}),
			expect.objectContaining({
				_tag: "ToolUse",
				itemId: "background_task_background-task-1",
				tool: "Bash",
				backgroundTask: { taskId: "background-task-1" },
				input: expect.objectContaining({
					command: "npm run dev",
					description: "Restart dev server",
					task_id: "background-task-1",
				}),
			}),
		]);
		expect(events.some((event) => event._tag === "SubagentSummary")).toBe(
			false,
		);
		expect(
			events.some(
				(event) =>
					event._tag === "AssistantMessage" &&
					event.parentItemId === "background-shell-1",
			),
		).toBe(false);
		expect(events.filter((event) => event._tag === "ToolResult")).toEqual([
			expect.objectContaining({
				itemId: "background_task_background-task-1",
				isError: false,
			}),
			expect.objectContaining({
				itemId: "background-shell-1",
				isError: false,
			}),
		]);
	});

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
		// Progress narrates streamed tool calls; only the final summary is text.
		expect(
			events
				.filter(
					(event) =>
						event._tag === "AssistantMessage" &&
						event.parentItemId === "agent-tool-1",
				)
				.map((event) => (event._tag === "AssistantMessage" ? event.text : "")),
		).toEqual(["Retention audit complete"]);
	});

	it("does not guess that an unknown task notification is a subagent", () => {
		const events = translateClaudeSdkMessages([
			sdk({
				type: "system",
				subtype: "task_notification",
				task_id: "unknown-task",
				tool_use_id: "unknown-tool",
				status: "failed",
				output_file: "/private/internal/output.txt",
				summary: "Task stopped",
				usage: { total_tokens: 0, tool_uses: 0, duration_ms: 100 },
			}),
		]);

		expect(events).toEqual([]);
	});

	it("marks a failed local background task as an error without agent events", () => {
		const events = translateClaudeSdkMessages([
			sdk({
				type: "assistant",
				parent_tool_use_id: null,
				message: {
					content: [
						{
							type: "tool_use",
							id: "failed-shell",
							name: "Bash",
							input: { command: "npm run dev" },
						},
					],
				},
			}),
			sdk({
				type: "system",
				subtype: "task_started",
				task_id: "failed-task",
				tool_use_id: "failed-shell",
				description: "Start dev server",
				task_type: "local_bash",
			}),
			sdk({
				type: "system",
				subtype: "task_notification",
				task_id: "failed-task",
				tool_use_id: "failed-shell",
				status: "failed",
				output_file: "/private/internal/output.txt",
				summary: "Process exited",
				usage: { total_tokens: 0, tool_uses: 1, duration_ms: 200 },
			}),
		]);

		expect(events).toContainEqual(
			expect.objectContaining({
				_tag: "ToolResult",
				itemId: "background_task_failed-task",
				isError: true,
			}),
		);
		expect(events.some((event) => event._tag === "SubagentSummary")).toBe(
			false,
		);
	});

	it("announces a turn the CLI starts on its own after a background task", () => {
		const result = sdk({
			type: "result",
			subtype: "success",
			is_error: false,
			result: "",
			parent_tool_use_id: null,
		});
		const reply = (text: string) =>
			sdk({
				type: "assistant",
				parent_tool_use_id: null,
				message: { id: `msg-${text}`, content: [{ type: "text", text }] },
			});
		const events = translateClaudeSdkMessages(
			[
				reply("Builder A is done"),
				result,

				sdk({
					type: "assistant",
					parent_tool_use_id: "agent-1",
					message: {
						id: "msg-child",
						content: [{ type: "text", text: "still building" }],
					},
				}),
				reply("Builder B is done"),
			],
			{ liveTurns: true },
		);

		expect(
			events
				.filter(
					(event) =>
						event._tag === "ProviderTurnStarted" ||
						event._tag === "AssistantMessage" ||
						event._tag === "Completed",
				)
				.map((event) =>
					event._tag === "AssistantMessage" ? event.text : event._tag,
				),
		).toEqual([
			"ProviderTurnStarted",
			"Builder A is done",
			"Completed",
			"still building",
			"ProviderTurnStarted",
			"Builder B is done",
		]);
	});

	it("does not announce provider turns in recorded transcripts", () => {
		const events = translateClaudeSdkMessages([
			sdk({
				type: "assistant",
				parent_tool_use_id: null,
				message: { id: "msg-1", content: [{ type: "text", text: "hi" }] },
			}),
		]);

		expect(events.some((event) => event._tag === "ProviderTurnStarted")).toBe(
			false,
		);
	});

	it("nests a sub-agent's background shell under that sub-agent", () => {
		const events = translateClaudeSdkMessages([
			sdk({
				type: "assistant",
				parent_tool_use_id: "agent-1",
				message: {
					content: [
						{
							type: "tool_use",
							id: "child-shell",
							name: "Bash",
							input: { command: "render", run_in_background: true },
						},
					],
				},
			}),
			sdk({
				type: "system",
				subtype: "task_started",
				task_id: "child-task",
				tool_use_id: "child-shell",
				description: "Render frames",
				task_type: "local_bash",
			}),
		]);

		expect(events).toContainEqual(
			expect.objectContaining({
				_tag: "ToolUse",
				itemId: "background_task_child-task",
				backgroundTask: { taskId: "child-task" },
				parentItemId: "agent-1",
			}),
		);
	});
});
