import { describe, expect, it } from "vitest";

import {
	classifyGrokRpcError,
	createGrokEventCursor,
	createGrokLifecycle,
	decodeAskUserQuestionRequest,
	decodeGrokInitializeResult,
	decodeGrokNotification,
	decodePlanApprovalRequest,
	isSupportedGrokVersion,
	mapGrokMode,
	translateGrokExtensionMethod,
	translateGrokExtensionUpdate,
} from "../../../src/drivers/grok/protocol.ts";

describe("Grok native ACP protocol", () => {
	it("decodes initialization capabilities and the agent version", () => {
		const result = decodeGrokInitializeResult({
			meta: { agentVersion: "0.2.101" },
			authMethods: [{ id: "cached_token" }],
			agentCapabilities: {
				loadSession: true,
				mcpCapabilities: { http: true, sse: true },
			},
		});
		expect(result.agentVersion).toBe("0.2.101");
		expect(result.authMethods).toEqual(["cached_token"]);
		expect(result.mcp).toEqual({ http: true, sse: true });
	});

	it("rejects unknown and outdated native ACP releases", () => {
		expect(isSupportedGrokVersion("0.2.100")).toBe(false);
		expect(isSupportedGrokVersion("grok 0.2.101 (abc)")).toBe(true);
		expect(isSupportedGrokVersion("0.3.0")).toBe(true);
		expect(isSupportedGrokVersion("dev")).toBe(false);
	});

	it("preserves outer metadata and decodes native updates", () => {
		const notification = decodeGrokNotification({
			sessionId: "s1",
			update: { sessionUpdate: "current_mode_update", currentModeId: "plan" },
			_meta: {
				eventId: "s1-42",
				promptId: "p1",
				isReplay: true,
				agentTimestampMs: 123,
				totalTokens: 77,
			},
		});
		expect(notification.meta).toMatchObject({
			eventId: "s1-42",
			promptId: "p1",
			isReplay: true,
			timestampMs: 123,
			totalTokens: 77,
		});
		expect(notification.update).toMatchObject({
			sessionUpdate: "current_mode_update",
		});
	});

	it("decodes blocking plan approval and maps modes", () => {
		expect(
			decodePlanApprovalRequest({
				sessionId: "s",
				toolCallId: "t",
				planContent: "ship it",
			}),
		).toEqual({ sessionId: "s", toolCallId: "t", planContent: "ship it" });
		expect(mapGrokMode("plan")).toBe("plan");
		expect(mapGrokMode("default")).toBe("default");
		expect(mapGrokMode("acceptEdits")).toBe("default");
	});

	it("decodes typed user questions", () => {
		const request = decodeAskUserQuestionRequest({
			sessionId: "s",
			toolCallId: "ask-1",
			mode: "plan",
			questions: [
				{
					question: "Ship?",
					options: [{ label: "Yes", description: "Ship now" }],
				},
			],
		});
		expect(request.questions[0]?.options[0]?.label).toBe("Yes");
	});

	it("deduplicates replay/live overlap and advances only on commit", () => {
		const cursor = createGrokEventCursor("s-4");
		expect(cursor.shouldProcess("s-4")).toBe(false);
		expect(cursor.shouldProcess("s-5")).toBe(true);
		expect(cursor.shouldProcess("s-5")).toBe(false);
		expect(cursor.value()).toBe("s-4");
		cursor.resetPending();
		expect(cursor.shouldProcess("s-5")).toBe(true);
		cursor.commit("s-5");
		expect(cursor.value()).toBe("s-5");
		expect(cursor.shouldProcess("s-5")).toBe(false);
		expect(cursor.shouldProcess("replacement-1")).toBe(true);
	});

	it("classifies structured errors without inspecting prompt text", () => {
		expect(
			classifyGrokRpcError({ code: 401, message: "AuthorizationRequired" }),
		).toBe("auth");
		expect(classifyGrokRpcError({ code: 429, message: "quota" })).toBe(
			"billing",
		);
		expect(
			classifyGrokRpcError({
				code: -32603,
				data: { code: "unauthorized" },
			}),
		).toBe("auth");
		expect(classifyGrokRpcError({ code: -32003 })).toBe("billing");
		expect(classifyGrokRpcError({ code: -32601, message: "missing" })).toBe(
			"unsupported-method",
		);
		expect(classifyGrokRpcError({ code: -32800, message: "cancelled" })).toBe(
			"cancellation",
		);
	});

	it("enforces deterministic lifecycle transitions", () => {
		const lifecycle = createGrokLifecycle();
		lifecycle.transition("authentication");
		lifecycle.transition("idle");
		lifecycle.transition("running");
		lifecycle.transition("waiting-for-input");
		expect(lifecycle.current()).toBe("waiting-for-input");
		expect(() => lifecycle.transition("authentication")).toThrow(
			/Invalid Grok lifecycle/,
		);
	});

	it("maps native goal and subagent progress notifications", () => {
		expect(
			translateGrokExtensionUpdate(
				{
					sessionUpdate: "goal_updated",
					goal_id: "g1",
					objective: "Ship",
					status: "active",
					token_budget: 1000,
					tokens_used: 250,
					elapsed_ms: 5000,
				},
				10_000,
			)[0],
		).toMatchObject({
			_tag: "GoalUpdated",
			goal: { threadId: "g1", tokensUsed: 250, timeUsedSeconds: 5 },
		});
		expect(
			translateGrokExtensionUpdate({
				sessionUpdate: "goal_updated",
				status: "back_off_paused",
			})[0],
		).toMatchObject({ _tag: "GoalUpdated", goal: { status: "paused" } });
		expect(
			translateGrokExtensionUpdate({
				sessionUpdate: "subagent_progress",
				subagent_id: "a1",
				parent_session_id: "p1",
				child_session_id: "c1",
				duration_ms: 50,
				turn_count: 2,
				tool_call_count: 3,
				tokens_used: 99,
				context_usage_pct: 12.5,
				tools_used: ["Read"],
				error_count: 0,
			})[0],
		).toMatchObject({
			_tag: "SubagentProgress",
			childId: "a1",
			turns: 2,
			toolsUsed: ["Read"],
		});
	});

	it("maps turn usage, compaction, retry, recovery, and task lifecycle", () => {
		expect(
			translateGrokExtensionUpdate({
				sessionUpdate: "turn_completed",
				usage: { inputTokens: 10, outputTokens: 3, cachedReadTokens: 2 },
			}),
		).toEqual([
			{
				_tag: "UsageDelta",
				inputTokens: 10,
				outputTokens: 3,
				cacheReadTokens: 2,
				cacheCreationTokens: 0,
				model: "",
			},
			{ _tag: "Status", status: "idle" },
		]);
		expect(
			translateGrokExtensionUpdate({
				sessionUpdate: "auto_compact_started",
				tokens_used: 100,
			}),
		).toEqual([
			expect.objectContaining({
				_tag: "ContextCompaction",
				status: "in_progress",
				beforeTokens: 100,
			}),
		]);
		expect(
			translateGrokExtensionUpdate({
				sessionUpdate: "retry_state",
				type: "retrying",
			}),
		).toEqual([{ _tag: "Status", status: "running" }]);
		expect(
			translateGrokExtensionMethod("x.ai/task_backgrounded", {
				update: {
					sessionUpdate: "task_backgrounded",
					tool_call_id: "call-1",
					task_id: "task-1",
					command: "bun test",
					cwd: "/repo",
				},
			})[0],
		).toMatchObject({
			_tag: "ToolUse",
			itemId: "call-1",
			tool: "BackgroundTask",
		});
	});
});
