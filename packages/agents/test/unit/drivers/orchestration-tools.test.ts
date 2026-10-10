import {
	callOrchestrationTool,
	ensureOrchestrationPermission,
	MUTATING_ORCHESTRATION_TOOLS,
	ORCHESTRATION_MCP_SERVER_NAME,
	ORCHESTRATION_MCP_TOOLS,
	type OrchestrationToolDeps,
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
			"memory_write",
			"memory_read",
			"memory_search",
			"memory_verify",
		]);
	});

	test("marks read-only and mutating tools explicitly", () => {
		expect([...READ_ONLY_ORCHESTRATION_TOOLS].sort()).toEqual([
			"list_models",
			"list_threads",
			"memory_read",
			"memory_search",
			"read_thread",
			"whoami",
		]);
		expect([...MUTATING_ORCHESTRATION_TOOLS].sort()).toEqual([
			"create_session",
			"create_thread",
			"memory_verify",
			"memory_write",
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

	const stubDeps = (): OrchestrationToolDeps => ({
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
		memoryWrite: async () => ({ ok: true, note: "01-note" }),
		memoryRead: async () => ({
			ok: true,
			note: null,
			content: "# Memory Index",
		}),
		memorySearch: async () => ({ ok: true, hits: [] }),
		memoryVerify: async () => ({
			ok: true as const,
			note: "01-note",
			status: "verified" as const,
		}),
	});

	test("generic dispatcher calls the bound deps", async () => {
		const result = await callOrchestrationTool(stubDeps(), "whoami", {});
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain("approval-gated");
	});

	test("memory tools reject an invalid scope instead of defaulting", async () => {
		let writeCalls = 0;
		const deps: OrchestrationToolDeps = {
			...stubDeps(),
			memoryWrite: async () => {
				writeCalls += 1;
				return { ok: true, note: "01-note" };
			},
		};
		const write = await callOrchestrationTool(deps, "memory_write", {
			title: "t",
			text: "x",
			scope: "sessoin",
		});
		expect(write.isError).toBe(true);
		expect(write.content[0]?.text).toContain("invalid scope");
		expect(writeCalls).toBe(0);

		for (const [name, args] of [
			["memory_read", { scope: "everywhere" }],
			["memory_search", { query: "x", scope: "everywhere" }],
		] as const) {
			const result = await callOrchestrationTool(deps, name, args);
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain("invalid scope");
		}
	});

	test("memory_verify is mutating and dispatches with scope", async () => {
		expect(MUTATING_ORCHESTRATION_TOOLS.has("memory_verify")).toBe(true);
		let seen: { note: string; scope?: string } | undefined;
		const deps: OrchestrationToolDeps = {
			...stubDeps(),
			memoryVerify: async (input) => {
				seen = input;
				return { ok: true, note: input.note, status: "verified" };
			},
		};
		const ok = await callOrchestrationTool(deps, "memory_verify", {
			note: "01-first",
			scope: "session",
		});
		expect(ok.isError).toBeUndefined();
		expect(seen).toEqual({ note: "01-first", scope: "session" });
		const bad = await callOrchestrationTool(deps, "memory_verify", {
			note: "01-first",
			scope: "bogus",
		});
		expect(bad.isError).toBe(true);
	});
});
