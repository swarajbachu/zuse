import {
	callOrchestrationTool,
	ensureOrchestrationPermission,
	MUTATING_ORCHESTRATION_TOOLS,
	ORCHESTRATION_MCP_SERVER_NAME,
	ORCHESTRATION_MCP_TOOLS,
	orchestrationMcpPromptHint,
	READ_ONLY_ORCHESTRATION_TOOLS,
} from "@zuse/agents/drivers/orchestration-tools";
import { validateGenerativeUiSpec } from "@zuse/utils/generative-ui";
import { describe, expect, test } from "vitest";

describe("orchestration MCP tools", () => {
	test.each([
		"create_session",
		"master_action",
		"automation_save",
	] as const)("denies %s in plan mode without requesting permission", async (toolName) => {
		let requestCount = 0;
		await expect(
			ensureOrchestrationPermission(
				toolName,
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
			"schedule_task",
			"list_scheduled_tasks",
			"update_scheduled_task",
			"delete_scheduled_task",
			"trigger_scheduled_task",
			"request_secret",
			"list_secret_requests",
			"automation_catalog",
			"automation_save",
			"orchestrator_capabilities",
			"delegate_task",
			"task_status",
			"task_cancel",
			"interrupt_thread",
			"master_state",
			"master_action",
			"create_thread",
			"create_session",
			"send_to_thread",
			"wait_for_thread",
			"read_thread",
			"list_threads",
			"list_models",
			"whoami",
			"emit_ui",
		]);
	});

	test("emit_ui examples are valid and never teach prompt buttons", () => {
		const description =
			ORCHESTRATION_MCP_TOOLS.find((tool) => tool.name === "emit_ui")
				?.description ?? "";
		const examples = description
			.split("\n\n")
			.filter((block) => block.startsWith("Example"))
			.map((block) => block.split("\n").slice(1).join("\n"));
		expect(examples.length).toBeGreaterThan(0);
		for (const spec of examples)
			expect(validateGenerativeUiSpec(spec)).toEqual({ ok: true });
		expect(description).not.toContain("FollowUps");
	});

	test("marks read-only and mutating tools explicitly", () => {
		expect([...READ_ONLY_ORCHESTRATION_TOOLS].sort()).toEqual([
			"automation_catalog",
			"emit_ui",
			"list_models",
			"list_scheduled_tasks",
			"list_secret_requests",
			"list_threads",
			"master_state",
			"orchestrator_capabilities",
			"read_thread",
			"task_status",
			"wait_for_thread",
			"whoami",
		]);
		expect([...MUTATING_ORCHESTRATION_TOOLS].sort()).toEqual([
			"automation_save",
			"create_session",
			"create_thread",
			"delegate_task",
			"delete_scheduled_task",
			"interrupt_thread",
			"master_action",
			"request_secret",
			"schedule_task",
			"send_to_thread",
			"task_cancel",
			"trigger_scheduled_task",
			"update_scheduled_task",
		]);
	});

	test("emit_ui requires a spec and stays display-only", async () => {
		const emitUi = {
			calls: [] as Array<{ spec: string }>,
			fn: async (input: { spec: string }) => {
				emitUi.calls.push(input);
				return { ok: true as const, messageId: "m_ui" };
			},
		};
		const deps = {
			createWorktree: async () => ({ ok: false as const, error: "unused" }),
			createThread: async () => ({ ok: false as const, error: "unused" }),
			createSession: async () => ({ ok: false as const, error: "unused" }),
			sendToThread: async () => ({ ok: false as const, error: "unused" }),
			readThread: async () => ({ ok: false as const, error: "unused" }),
			listThreads: async () => ({ ok: false as const, error: "unused" }),
			listModels: async () => ({ ok: false as const, error: "unused" }),
			whoami: async () => ({
				sessionId: "s",
				chatId: "c",
				projectId: "p",
				worktreeId: null,
				providerId: "claude",
				model: "m",
				autonomyLevel: "approval-gated",
			}),
			emitUi: emitUi.fn,
		};

		const missing = await callOrchestrationTool(deps, "emit_ui", {});
		expect(missing.isError).toBe(true);
		expect(emitUi.calls).toEqual([]);

		const spec = 'root = Stat("Downloads", "12k")';
		const result = await callOrchestrationTool(deps, "emit_ui", { spec });
		expect(emitUi.calls).toEqual([{ spec }]);
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain("m_ui");

		let requested = 0;
		await ensureOrchestrationPermission(
			"emit_ui",
			{ spec },
			{
				getPermissionMode: () => "default",
				getRuntimeMode: () => "approval-required",
				requestPermission: async () => {
					requested += 1;
					return { _tag: "Deny" };
				},
			},
		);
		expect(requested).toBe(0);
	});

	test("emit_ui surfaces dep validation failures as tool errors", async () => {
		const deps = {
			createWorktree: async () => ({ ok: false as const, error: "unused" }),
			createThread: async () => ({ ok: false as const, error: "unused" }),
			createSession: async () => ({ ok: false as const, error: "unused" }),
			sendToThread: async () => ({ ok: false as const, error: "unused" }),
			readThread: async () => ({ ok: false as const, error: "unused" }),
			listThreads: async () => ({ ok: false as const, error: "unused" }),
			listModels: async () => ({ ok: false as const, error: "unused" }),
			whoami: async () => ({
				sessionId: "s",
				chatId: "c",
				projectId: "p",
				worktreeId: null,
				providerId: "claude",
				model: "m",
				autonomyLevel: "approval-gated",
			}),
			emitUi: async () => ({
				ok: false as const,
				error: 'Unknown component "Confetti"',
			}),
		};
		const result = await callOrchestrationTool(deps, "emit_ui", {
			spec: 'root = Confetti("yay")',
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("Confetti");
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

	test("prompt hint explains managed delegation and provider-native subagents", () => {
		const hint = orchestrationMcpPromptHint();
		expect(hint).toContain("delegate_task");
		expect(hint).toContain("task_status");
		expect(hint).not.toContain("Smoke flow");
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
		expect(sendToThread?.description).toContain(
			"queued reports durable queued delivery",
		);
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
				emitUi: async () => ({ ok: true as const, messageId: "m_ui" }),
			},
			"whoami",
			{},
		);
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain("approval-gated");
	});

	test("master_action needs a stable command ID and passes it through", async () => {
		const calls: Array<
			[string | undefined, boolean | undefined, string | undefined]
		> = [];
		const deps = {
			createWorktree: async () => ({ ok: false as const, error: "unused" }),
			createThread: async () => ({ ok: false as const, error: "unused" }),
			createSession: async () => ({ ok: false as const, error: "unused" }),
			sendToThread: async () => ({ ok: false as const, error: "unused" }),
			readThread: async () => ({ ok: false as const, error: "unused" }),
			listThreads: async () => ({ ok: false as const, error: "unused" }),
			listModels: async () => ({ ok: false as const, error: "unused" }),
			whoami: async () => ({
				sessionId: "s",
				chatId: "c",
				projectId: "p",
				worktreeId: null,
				providerId: "claude",
				model: "m",
				autonomyLevel: "approval-gated",
			}),
			emitUi: async () => ({ ok: true as const, messageId: "m" }),
			master: async (
				commandJson?: string,
				readOnly?: boolean,
				commandId?: string,
			) => {
				calls.push([commandJson, readOnly, commandId]);
				return { ok: true };
			},
		};
		const action = '{"_tag":"note"}';
		const missing = await callOrchestrationTool(deps, "master_action", {
			commandJson: action,
		});
		expect(missing.isError).toBe(true);
		expect(calls).toEqual([]);

		await callOrchestrationTool(deps, "master_action", {
			commandJson: action,
			commandId: "delegate-search",
		});
		await callOrchestrationTool(deps, "master_state", {});
		expect(calls).toEqual([
			[action, false, "delegate-search"],
			[undefined, true, undefined],
		]);
	});
});

test("native automation tools validate saves and return persisted results", async () => {
	const calls: unknown[] = [];
	const deps = {
		projectAutomation: async (input: unknown) => {
			calls.push(input);
			return {
				ok: true,
				result: input
					? { id: "persisted-automation" }
					: { projectId: "current" },
			};
		},
	} as Parameters<typeof callOrchestrationTool>[0];
	const invalid = await callOrchestrationTool(deps, "automation_save", {
		configJson: "{}",
	});
	expect(invalid.isError).toBe(true);
	expect(calls).toHaveLength(0);
	await callOrchestrationTool(deps, "automation_catalog", {});
	const input = { configJson: '{"enabled":false}', requestId: "create-1" };
	const result = await callOrchestrationTool(deps, "automation_save", input);
	expect(calls).toEqual([undefined, input]);
	expect(JSON.parse(result.content[0]?.text ?? "null")).toEqual({
		ok: true,
		result: { id: "persisted-automation" },
	});
});
