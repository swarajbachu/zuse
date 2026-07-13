import {
	callOrchestrationTool,
	ensureOrchestrationPermission,
	MUTATING_ORCHESTRATION_TOOLS,
	ORCHESTRATION_MCP_SERVER_NAME,
	ORCHESTRATION_MCP_TOOLS,
	orchestrationMcpPromptHint,
	READ_ONLY_ORCHESTRATION_TOOLS,
} from "@zuse/agents/drivers/orchestration-tools";
import { describe, expect, test } from "vitest";

describe("orchestration MCP tools", () => {
	test("denies plan-mode mutations without requesting permission", async () => {
		let requestCount = 0;
		await expect(
			ensureOrchestrationPermission(
				"create_session",
				{ task: "test" },
				{
					getPermissionMode: () => "plan",
					getRuntimeMode: () => "full-access",
					requestPermission: async () => {
						requestCount += 1;
						return { _tag: "AllowOnce" };
					},
				},
			),
		).rejects.toThrow(/blocked/i);
		expect(requestCount).toBe(0);
	});

	test("exposes the stable provider-neutral tool set", () => {
		expect(ORCHESTRATION_MCP_SERVER_NAME).toBe("zuse-orchestration");
		expect(ORCHESTRATION_MCP_TOOLS.map((tool) => tool.name)).toEqual([
			"create_thread",
			"create_session",
			"send_to_thread",
			"read_thread",
			"list_threads",
			"list_models",
			"whoami",
		]);
	});

	test("marks read-only and mutating tools explicitly", () => {
		expect([...READ_ONLY_ORCHESTRATION_TOOLS].sort()).toEqual([
			"list_models",
			"list_threads",
			"read_thread",
			"whoami",
		]);
		expect([...MUTATING_ORCHESTRATION_TOOLS].sort()).toEqual([
			"create_session",
			"create_thread",
			"send_to_thread",
		]);
	});

	test("schemas encode required arguments for write-like tools", () => {
		const createThread = ORCHESTRATION_MCP_TOOLS.find(
			(tool) => tool.name === "create_thread",
		);
		const createSession = ORCHESTRATION_MCP_TOOLS.find(
			(tool) => tool.name === "create_session",
		);
		const sendToThread = ORCHESTRATION_MCP_TOOLS.find(
			(tool) => tool.name === "send_to_thread",
		);
		expect(createThread?.inputSchema.required).toEqual(["task"]);
		expect(createSession?.inputSchema.required).toEqual(["task"]);
		expect(sendToThread?.inputSchema.required).toEqual(["sessionId", "text"]);
	});

	test("prompt hint tells models not to substitute provider subagents", () => {
		const hint = orchestrationMcpPromptHint();
		expect(hint).toContain("zuse-orchestration");
		expect(hint).toContain("whoami -> list_threads");
		expect(hint).toContain("list_models");
		expect(hint).toContain("Do not substitute");
		expect(hint).toContain("worker/explorer/default");
	});

	test("descriptions teach workspace-vs-thread semantics", () => {
		const createThread = ORCHESTRATION_MCP_TOOLS.find(
			(tool) => tool.name === "create_thread",
		);
		const createSession = ORCHESTRATION_MCP_TOOLS.find(
			(tool) => tool.name === "create_session",
		);
		const sendToThread = ORCHESTRATION_MCP_TOOLS.find(
			(tool) => tool.name === "send_to_thread",
		);
		const listModels = ORCHESTRATION_MCP_TOOLS.find(
			(tool) => tool.name === "list_models",
		);

		expect(createThread?.description).toContain(
			"ALWAYS creates a new Zuse workspace",
		);
		expect(createThread?.description).toContain("use create_session instead");
		expect(createSession?.description).toContain("YOUR OWN current chat");
		expect(createSession?.description).toContain(
			"never creates a new sidebar chat",
		);
		expect(sendToThread?.description).toContain("queued is always false");
		expect(listModels?.description).toContain("providerId/model");
		expect(sendToThread?.description).not.toContain(
			"delivered when it goes idle",
		);
	});

	test("generic dispatcher calls the bound deps", async () => {
		const result = await callOrchestrationTool(
			{
				createWorktree: async () => ({
					ok: true,
					worktreeId: "wt_1",
					path: "/tmp/worktree",
					branch: "test",
				}),
				createThread: async () => ({
					ok: true,
					chatId: "chat_1",
					sessionId: "s_1",
					title: "Thread",
					worktreeId: "wt_1",
					path: "/tmp/worktree",
					branch: "test",
				}),
				createSession: async () => ({
					ok: true,
					chatId: "chat_2",
					sessionId: "s_2",
					title: "Session",
					worktreeId: null,
				}),
				sendToThread: async () => ({
					ok: true,
					queued: false,
					chatId: "chat_target",
				}),
				readThread: async () => ({
					ok: true,
					status: "idle",
					messages: [],
				}),
				listThreads: async () => ({ ok: true, threads: [] }),
				listModels: async () => ({
					ok: true,
					providers: [
						{
							providerId: "codex",
							defaultModel: "gpt-5.2-codex-max",
							models: [
								{
									id: "gpt-5.2-codex-max",
									label: "GPT-5.2 Codex Max",
									defaultModel: true,
								},
							],
						},
					],
				}),
				whoami: async () => ({
					sessionId: "s_self",
					chatId: "chat_self",
					projectId: "project",
					worktreeId: null,
					providerId: "claude",
					model: "claude-sonnet-5",
					autonomyLevel: "approval-gated",
				}),
			},
			"whoami",
			{},
		);
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain("approval-gated");
	});
});
