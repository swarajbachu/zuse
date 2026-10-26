import { describe, expect, it } from "vitest";
import {
	claudeReadOnlyToolAllowed,
	claudeToolPermissionPolicy,
	translateClaudeSdkMessages,
} from "../../../src/drivers/claude.ts";
import { withClaudeTaskTracking } from "../../../src/drivers/claude-env.ts";

describe("Claude task tracking", () => {
	it.each([
		"TaskCreate",
		"TaskUpdate",
		"TaskGet",
		"TaskList",
	])("allows checklist bookkeeping without approval prompts (%s)", (tool) => {
		expect(claudeToolPermissionPolicy(tool, {}, "approval-required")).toEqual({
			kind: "auto-allow",
		});
	});
	it.each([
		"TaskCreate",
		"TaskUpdate",
	])("keeps checklist writes unavailable to read-only sessions (%s)", (tool) => {
		expect(claudeReadOnlyToolAllowed(tool, {}, new Set())).toBe(false);
	});
	it("opts in without replacing the user's task format or environment", () => {
		const env = { EXISTING: "value", CLAUDE_CODE_ENABLE_TASKS: "0" };
		expect(withClaudeTaskTracking(env)).toEqual({
			...env,
			CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
		});
		expect(env).not.toHaveProperty("CLAUDE_CODE_ENABLE_TODO_TOOLS");
	});
	it.each([
		"0",
		"false",
		"1",
	])("preserves an explicit task-tool setting: %s", (value) => {
		expect(
			withClaudeTaskTracking({ CLAUDE_CODE_ENABLE_TODO_TOOLS: value })
				.CLAUDE_CODE_ENABLE_TODO_TOOLS,
		).toBe(value);
	});
	it("preserves structured task creation results and correlates them by tool id", () => {
		const events = translateClaudeSdkMessages([
			{
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							id: "create",
							name: "TaskCreate",
							input: { subject: "Inspect" },
						},
					],
				},
				parent_tool_use_id: null,
			},
			{
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "other",
							content: "Other result",
						},
					],
				},
				tool_use_result: { unrelated: true },
				parent_tool_use_id: null,
			},
			{
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "create",
							content: [{ type: "text", text: "Task created" }],
						},
					],
				},
				tool_use_result: { task: { id: "7", subject: "Inspect" } },
				parent_tool_use_id: null,
			},
		] as never);
		expect(events.filter((e) => e._tag === "ToolResult")).toMatchObject([
			{ itemId: "other", output: "Other result" },
			{ itemId: "create", output: { task: { id: "7", subject: "Inspect" } } },
		]);
	});
	it("retains legacy result text when structured output is absent", () => {
		const events = translateClaudeSdkMessages([
			{
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							id: "create",
							name: "TaskCreate",
							input: { subject: "Inspect" },
						},
					],
				},
				parent_tool_use_id: null,
			},
			{
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "create",
							content: "Task #7 created successfully: Inspect",
						},
					],
				},
				parent_tool_use_id: null,
			},
		] as never);
		expect(events.at(-1)).toMatchObject({
			output: "Task #7 created successfully: Inspect",
		});
	});
});
