import { execFileSync } from "node:child_process";
import type { ThreadItem } from "@zuse/agents/codex-generated/v2/ThreadItem";
import {
	buildCodexTurnMode,
	codexApprovalPolicy,
	codexDetachedAgentFromSubAgentActivity,
	codexDetachedAgentFromRawSpawn,
	codexDetachedAgentToolUse,
	codexFinishDetachedAgent,
	codexReasoningEffort,
	codexSandboxPolicy,
	codexWithDetachedParent,
	codexWritableRootsForCwd,
	readCodexSubAgentActivity,
	supportsCodexNativePlanMode,
	translateCodexCollabItem,
	translateCodexItem,
	translateCodexStatusNotification,
} from "@zuse/agents/drivers/codex";
import { type AgentEvent, AgentItemId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

const tags = (events: ReadonlyArray<AgentEvent>): string[] =>
	events.map((event) => event._tag);

const only = <T extends AgentEvent["_tag"]>(
	events: ReadonlyArray<AgentEvent>,
	tag: T,
): Extract<AgentEvent, { _tag: T }> => {
	expect(tags(events)).toEqual([tag]);
	return events[0] as Extract<AgentEvent, { _tag: T }>;
};

describe("Codex subAgentActivity items", () => {
	// Shape captured from a live codex 0.144.1 app-server: spawn_agent surfaces
	// on the parent thread as an item/completed subAgentActivity notification.
	const capturedStart = {
		type: "subAgentActivity",
		id: "call_MmBpqT9m0rI5n89NEKXVuvjO",
		kind: "started",
		agentThreadId: "019f5975-4e1e-7703-89e2-22e71b282230",
		agentPath: "/root/probe_child",
	};

	it("parses the captured item shape", () => {
		expect(readCodexSubAgentActivity(capturedStart)).toEqual({
			id: "call_MmBpqT9m0rI5n89NEKXVuvjO",
			kind: "started",
			agentThreadId: "019f5975-4e1e-7703-89e2-22e71b282230",
			agentPath: "/root/probe_child",
		});
	});

	it("rejects other item types and malformed activities", () => {
		expect(readCodexSubAgentActivity(null)).toBeNull();
		expect(
			readCodexSubAgentActivity({ type: "agentMessage", text: "hi" }),
		).toBeNull();
		expect(
			readCodexSubAgentActivity({
				type: "subAgentActivity",
				id: "call_1",
				kind: "exploded",
				agentThreadId: "t1",
				agentPath: "/root/x",
			}),
		).toBeNull();
	});

	it("creates a detached agent keyed by the child thread id", () => {
		const activity = readCodexSubAgentActivity(capturedStart);
		expect(activity).not.toBeNull();
		if (activity === null) return;
		const agent = codexDetachedAgentFromSubAgentActivity(activity);
		expect(agent.childSessionId).toBe("019f5975-4e1e-7703-89e2-22e71b282230");
		expect(agent.agentName).toBe("probe_child");
		expect(codexDetachedAgentToolUse(agent)).toMatchObject({
			_tag: "ToolUse",
			itemId: "call_MmBpqT9m0rI5n89NEKXVuvjO",
			tool: "Agent",
			input: { description: "probe_child" },
			subagent: {
				childSessionId: "019f5975-4e1e-7703-89e2-22e71b282230",
				presentation: "detached",
			},
		});
	});

	it("routes child output into the detached run and finishes once", () => {
		const activity = readCodexSubAgentActivity(capturedStart);
		if (activity === null) throw new Error("expected activity");
		const agent = codexDetachedAgentFromSubAgentActivity(activity);
		const nested = codexWithDetachedParent(
			{
				_tag: "AssistantMessage",
				itemId: "m1" as AgentItemId,
				text: "hi",
			},
			agent,
		);
		expect(nested).toMatchObject({
			_tag: "AssistantMessage",
			parentItemId: "call_MmBpqT9m0rI5n89NEKXVuvjO",
		});
		const summary = codexFinishDetachedAgent(agent, false, 1200);
		expect(summary).toMatchObject({
			_tag: "SubagentSummary",
			agentName: "probe_child",
			summary: "hi",
			durationMs: 1200,
			isError: false,
			childSessionId: "019f5975-4e1e-7703-89e2-22e71b282230",
			presentation: "detached",
		});
		expect(codexFinishDetachedAgent(agent, false)).toBeNull();
	});
});

describe("Codex raw collaboration calls", () => {
	it("creates a detached agent from the captured spawn call and output", () => {
		const agent = codexDetachedAgentFromRawSpawn(
			"call_qxjx50XLFx5PllZaUN24C6Sd",
			JSON.stringify({
				agent_type: "default",
				message: "Reply with hi and hello",
			}),
			JSON.stringify({
				agent_id: "019f66b9-6fe8-7002-a0ae-b1d823574628",
				nickname: "Raman",
			}),
			100,
		);

		expect(agent).toMatchObject({
			parentItemId: "call_qxjx50XLFx5PllZaUN24C6Sd",
			childSessionId: "019f66b9-6fe8-7002-a0ae-b1d823574628",
			agentName: "Raman",
			prompt: "Reply with hi and hello",
			model: "inherit",
			startedAt: 100,
		});
	});

	it("ignores malformed spawn outputs", () => {
		expect(
			codexDetachedAgentFromRawSpawn("call_1", "{}", "not json"),
		).toBeNull();
	});
});

describe("translateCodexItem", () => {
	it("preserves dedicated plan items as marked assistant messages", () => {
		const item: ThreadItem = {
			type: "plan",
			id: "plan1",
			text: "# Proposed plan",
		};

		const event = only(translateCodexItem(item, "completed"), "AssistantMessage");
		expect(event.text).toBe("# Proposed plan");
		expect(event.isPlan).toBe(true);
	});

	it("maps a parsed read command to the canonical Read row", () => {
		const item: ThreadItem = {
			type: "commandExecution",
			id: "cmd1",
			command: "sed -n '1,20p' apps/server/src/index.ts",
			cwd: "/repo",
			processId: null,
			source: "agent",
			status: "inProgress",
			commandActions: [
				{
					type: "read",
					command: "sed -n '1,20p' apps/server/src/index.ts",
					name: "sed",
					path: "/repo/apps/server/src/index.ts",
				},
			],
			aggregatedOutput: null,
			exitCode: null,
			durationMs: null,
		};

		const ev = only(translateCodexItem(item, "started"), "ToolUse");
		expect(ev.tool).toBe("Read");
		expect(ev.input).toEqual({ file_path: "/repo/apps/server/src/index.ts" });
	});

	it("returns raw command output for a completed canonical Read", () => {
		const item: ThreadItem = {
			type: "commandExecution",
			id: "cmd1",
			command: "/bin/zsh -lc \"sed -n '1,220p' package.json\"",
			cwd: "/repo",
			processId: null,
			source: "agent",
			status: "completed",
			commandActions: [
				{
					type: "read",
					command: "sed -n '1,220p' package.json",
					name: "sed",
					path: "/repo/package.json",
				},
			],
			aggregatedOutput: '{\n  "name": "desktop"\n}\n',
			exitCode: 0,
			durationMs: 12,
		};

		const ev = only(translateCodexItem(item, "completed"), "ToolResult");
		expect(ev.output).toBe('{\n  "name": "desktop"\n}\n');
	});

	it("falls back to Bash for ordinary command execution", () => {
		const item: ThreadItem = {
			type: "commandExecution",
			id: "cmd2",
			command: "bun test apps/server/test/translate.test.ts",
			cwd: "/repo",
			processId: null,
			source: "agent",
			status: "inProgress",
			commandActions: [],
			aggregatedOutput: null,
			exitCode: null,
			durationMs: null,
		};

		const ev = only(translateCodexItem(item, "started"), "ToolUse");
		expect(ev.tool).toBe("Bash");
		expect(ev.input).toEqual({
			command: "bun test apps/server/test/translate.test.ts",
			cwd: "/repo",
		});
		expect(
			(ev.input as Record<string, unknown>)["description"],
		).toBeUndefined();
	});

	it("renders Codex file changes as patch-backed edit rows", () => {
		const item: ThreadItem = {
			type: "fileChange",
			id: "patch1",
			status: "completed",
			changes: [
				{
					path: "packages/agents/src/drivers/codex.ts",
					kind: { type: "update", move_path: null },
					diff: "@@ -1 +1 @@\n-old\n+new",
				},
			],
		};

		const out = translateCodexItem(item, "completed");
		expect(tags(out)).toEqual(["ToolUse", "ToolResult"]);
		const use = out[0] as Extract<AgentEvent, { _tag: "ToolUse" }>;
		expect(use.tool).toBe("Edit");
		expect(use.input).toEqual({
			file_path: "packages/agents/src/drivers/codex.ts",
			kind: "update",
			patch: "@@ -1 +1 @@\n-old\n+new",
			move_path: null,
		});
	});

	it("renders multi-file Codex file changes as patch-backed multi-edit rows", () => {
		const item: ThreadItem = {
			type: "fileChange",
			id: "patch-many",
			status: "completed",
			changes: [
				{
					path: "a.txt",
					kind: { type: "update", move_path: null },
					diff: "@@ -1 +1 @@\n-old\n+new",
				},
				{
					path: "b.txt",
					kind: { type: "add" },
					diff: "@@ -0,0 +1 @@\n+created",
				},
			],
		};

		const out = translateCodexItem(item, "completed");
		expect(tags(out)).toEqual(["ToolUse", "ToolResult"]);
		const use = out[0] as Extract<AgentEvent, { _tag: "ToolUse" }>;
		expect(use.tool).toBe("MultiEdit");
		expect(use.input).toEqual({
			patches: [
				{
					file_path: "a.txt",
					kind: "update",
					patch: "@@ -1 +1 @@\n-old\n+new",
					move_path: null,
				},
				{
					file_path: "b.txt",
					kind: "add",
					patch: "@@ -0,0 +1 @@\n+created",
					move_path: undefined,
				},
			],
		});
	});

	it("normalizes MCP tool names to Claude-style names", () => {
		const item: ThreadItem = {
			type: "mcpToolCall",
			id: "mcp1",
			server: "memoize",
			tool: "browser_screenshot",
			status: "inProgress",
			arguments: {},
			result: null,
			error: null,
			durationMs: null,
		};

		const ev = only(translateCodexItem(item, "started"), "ToolUse");
		expect(ev.tool).toBe("mcp__zuse__browser_screenshot");
	});

	it("keeps the orchestration server hyphen in mcpToolCall names", () => {
		const item: ThreadItem = {
			type: "mcpToolCall",
			id: "mcp-orch",
			server: "zuse-orchestration",
			tool: "create_thread",
			status: "inProgress",
			arguments: {},
			result: null,
			error: null,
			durationMs: null,
		};

		const ev = only(translateCodexItem(item, "started"), "ToolUse");
		expect(ev.tool).toBe("mcp__zuse-orchestration__create_thread");
	});

	it("renders context compaction as a compact event with token counts", () => {
		const item: ThreadItem = { type: "contextCompaction", id: "compact1" };

		const ev = only(
			translateCodexItem(item, "completed", {
				itemId: AgentItemId.make("compact1"),
				startedAt: 1_800_000_000,
				durationMs: 37_000,
				beforeTokens: 231_450,
				afterTokens: 9_535,
			}),
			"ContextCompaction",
		);
		expect(ev.itemId).toBe("compact1");
		expect(ev.providerId).toBe("codex");
		expect(ev.startedAt).toBe(1_800_000_000);
		expect(ev.durationMs).toBe(37_000);
		expect(ev.beforeTokens).toBe(231_450);
		expect(ev.afterTokens).toBe(9_535);
		expect(ev.status).toBe("completed");
	});

	it("renders context compaction gracefully without token counts", () => {
		const item: ThreadItem = { type: "contextCompaction", id: "compact1" };

		const ev = only(translateCodexItem(item, "completed"), "ContextCompaction");
		expect(ev.beforeTokens).toBeNull();
		expect(ev.afterTokens).toBeNull();
		expect(ev.status).toBe("completed");
		expect(ev.durationMs).toBeGreaterThanOrEqual(0);
	});
});

describe("translateCodexCollabItem", () => {
	it("creates a detached Agent row for a spawned child thread", () => {
		const item: Extract<ThreadItem, { type: "collabAgentToolCall" }> = {
			type: "collabAgentToolCall",
			id: "spawn-1",
			tool: "spawnAgent",
			status: "inProgress",
			senderThreadId: "parent-thread",
			receiverThreadIds: ["child-thread"],
			prompt: "Review the renderer",
			model: "gpt-5.5",
			reasoningEffort: "high",
			agentsStates: {},
		};

		expect(translateCodexCollabItem(item, "started")).toEqual([
			expect.objectContaining({
				_tag: "ToolUse",
				itemId: "spawn-1",
				tool: "Agent",
				subagent: {
					childSessionId: "child-thread",
					presentation: "detached",
				},
			}),
		]);
		expect(translateCodexCollabItem(item, "completed")).toEqual([]);
	});

	it("does not create duplicate rows for collaboration control calls", () => {
		const item: Extract<ThreadItem, { type: "collabAgentToolCall" }> = {
			type: "collabAgentToolCall",
			id: "wait-1",
			tool: "wait",
			status: "completed",
			senderThreadId: "parent-thread",
			receiverThreadIds: ["child-thread"],
			prompt: null,
			model: null,
			reasoningEffort: null,
			agentsStates: {},
		};
		expect(translateCodexCollabItem(item, "started")).toEqual([]);
	});
});

describe("translateCodexStatusNotification", () => {
	it("maps token usage notifications to exact context usage", () => {
		const ev = only(
			translateCodexStatusNotification(
				{
					method: "thread/tokenUsage/updated",
					params: {
						threadId: "thread1",
						turnId: "turn1",
						tokenUsage: {
							total: {
								totalTokens: 231_700,
								inputTokens: 220_000,
								cachedInputTokens: 0,
								outputTokens: 10_000,
								reasoningOutputTokens: 1_700,
							},
							last: {
								totalTokens: 1_000,
								inputTokens: 800,
								cachedInputTokens: 0,
								outputTokens: 200,
								reasoningOutputTokens: 0,
							},
							modelContextWindow: 258_400,
						},
					},
				},
				"thread1",
			) ?? [],
			"ContextUsage",
		);

		expect(ev.providerId).toBe("codex");
		expect(ev.usedTokens).toBe(1_000);
		expect(ev.windowTokens).toBe(258_400);
		expect(ev.precision).toBe("exact");
	});

	it("uses Codex last token usage for context instead of cumulative total", () => {
		const ev = only(
			translateCodexStatusNotification(
				{
					method: "thread/tokenUsage/updated",
					params: {
						threadId: "thread1",
						turnId: "turn1",
						tokenUsage: {
							total: {
								totalTokens: 8_913_426,
								inputTokens: 8_888_677,
								cachedInputTokens: 8_342_528,
								outputTokens: 24_749,
								reasoningOutputTokens: 5_466,
							},
							last: {
								totalTokens: 96_517,
								inputTokens: 96_505,
								cachedInputTokens: 82_816,
								outputTokens: 12,
								reasoningOutputTokens: 0,
							},
							modelContextWindow: 258_400,
						},
					},
				},
				"thread1",
			) ?? [],
			"ContextUsage",
		);

		expect(ev.usedTokens).toBe(96_517);
		expect(ev.windowTokens).toBe(258_400);
	});

	it("maps account rate-limit notifications to usage limits", () => {
		const ev = only(
			translateCodexStatusNotification(
				{
					method: "account/rateLimits/updated",
					params: {
						rateLimits: {
							limitId: "primary",
							limitName: "Codex weekly",
							primary: {
								usedPercent: 42,
								windowDurationMins: 10_080,
								resetsAt: 1_800_000_000,
							},
							secondary: null,
							credits: null,
							planType: null,
							rateLimitReachedType: null,
						},
					},
				},
				"thread1",
			) ?? [],
			"UsageLimit",
		);

		expect(ev.providerId).toBe("codex");
		expect(ev.label).toBe("7d limit");
		expect(ev.usedPercent).toBe(42);
		expect(ev.windowMinutes).toBe(10_080);
		expect(ev.resetsAt).toBe("2027-01-15T08:00:00.000Z");
	});

	it("maps primary and secondary Codex rate-limit windows", () => {
		const events =
			translateCodexStatusNotification(
				{
					method: "account/rateLimits/updated",
					params: {
						rateLimits: {
							limitId: "codex",
							limitName: "Codex usage",
							primary: {
								usedPercent: 14,
								windowDurationMins: 300,
								resetsAt: 1_783_010_100,
							},
							secondary: {
								usedPercent: 40,
								windowDurationMins: 10_080,
								resetsAt: 1_783_500_240,
							},
							credits: {
								hasCredits: true,
								unlimited: false,
								balance: "12.34",
							},
							planType: "pro",
							rateLimitReachedType: null,
						},
					},
				},
				"thread1",
			) ?? [];

		expect(tags(events)).toEqual(["UsageLimit", "UsageLimit"]);
		const primary = events[0] as Extract<AgentEvent, { _tag: "UsageLimit" }>;
		const secondary = events[1] as Extract<AgentEvent, { _tag: "UsageLimit" }>;
		expect(primary.label).toBe("5h limit");
		expect(primary.usedPercent).toBe(14);
		expect(primary.windowMinutes).toBe(300);
		expect(primary.resetsAt).toBe("2026-07-02T16:35:00.000Z");
		expect(secondary.label).toBe("7d limit");
		expect(secondary.usedPercent).toBe(40);
		expect(secondary.windowMinutes).toBe(10_080);
		expect(secondary.resetsAt).toBe("2026-07-08T08:44:00.000Z");
	});
});

describe("codexWritableRootsForCwd", () => {
	it("includes the real Git metadata dirs for worktree-safe git operations", () => {
		const cwd = process.cwd();
		const gitDirs = execFileSync(
			"git",
			["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
			{ cwd, encoding: "utf8" },
		)
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);

		expect(codexWritableRootsForCwd(cwd)).toEqual(
			expect.arrayContaining([cwd, ...gitDirs]),
		);
	});
});

describe("codexReasoningEffort", () => {
	it("passes only the selected model's supported efforts through to Codex", () => {
		expect(codexReasoningEffort("gpt-5.5", "xhigh")).toBe("xhigh");
		expect(codexReasoningEffort("gpt-5.5", "max")).toBeNull();
		expect(codexReasoningEffort("gpt-5.6-sol", "max")).toBe("max");
		expect(codexReasoningEffort("gpt-5.6-terra", "ultra")).toBe("ultra");
		expect(codexReasoningEffort("gpt-5.4", "xhigh")).toBeNull();
	});

	it("keeps standard efforts for custom models and drops unknown values", () => {
		expect(codexReasoningEffort("custom-model", "high")).toBe("high");
		expect(codexReasoningEffort("custom-model", "ultra")).toBeNull();
		expect(codexReasoningEffort(undefined, undefined)).toBeNull();
		expect(codexReasoningEffort("gpt-5.6-luna", "turbo")).toBeNull();
	});
});

describe("Codex plan mode", () => {
	it("requires both native collaboration modes in the capability response", () => {
		expect(
			supportsCodexNativePlanMode({
				data: [{ mode: "plan" }, { mode: "default" }],
			}),
		).toBe(true);
		expect(supportsCodexNativePlanMode({ data: [{ mode: "plan" }] })).toBe(
			false,
		);
		expect(supportsCodexNativePlanMode({})).toBe(false);
	});

	it("uses native collaboration mode without rewriting the user prompt", () => {
		expect(
			buildCodexTurnMode({
				permissionMode: "plan",
				supportsNativePlanMode: true,
				prompt: "Investigate the queue bug",
				model: "gpt-5.5",
				effort: "high",
			}),
		).toEqual({
			promptText: "Investigate the queue bug",
			collaborationMode: {
				mode: "plan",
				settings: {
					model: "gpt-5.5",
					reasoning_effort: "high",
					developer_instructions: null,
				},
			},
		});
	});

	it("sends native default mode when leaving plan mode", () => {
		expect(
			buildCodexTurnMode({
				permissionMode: "default",
				supportsNativePlanMode: true,
				prompt: "Implement it",
				model: "gpt-5.5",
				effort: null,
			}),
		).toEqual({
			promptText: "Implement it",
			collaborationMode: {
				mode: "default",
				settings: {
					model: "gpt-5.5",
					reasoning_effort: null,
					developer_instructions: null,
				},
			},
		});
	});

	it("keeps the instruction-prefix fallback for older app servers", () => {
		const result = buildCodexTurnMode({
			permissionMode: "plan",
			supportsNativePlanMode: false,
			prompt: "Investigate the queue bug",
			model: "gpt-5.5",
			effort: null,
		});

		expect(result.collaborationMode).toBeUndefined();
		expect(result.promptText).toContain("PLAN MODE");
		expect(result.promptText).toContain("Investigate the queue bug");
	});

	it("never asks for approval while retaining a read-only sandbox", () => {
		expect(codexApprovalPolicy("full-access", "plan")).toBe("never");
		expect(codexSandboxPolicy("full-access", "plan", "/repo")).toEqual({
			type: "readOnly",
			networkAccess: false,
		});
	});
});
