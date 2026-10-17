import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import {
	buildOrchestrationTools,
	type OrchestrationSessionTools,
	type OrchestrationToolDeps,
} from "@zuse/agents/drivers/orchestration-tools";
import {
	SimulatorTools,
	type SimulatorToolsClient,
} from "@zuse/agents/drivers/simulator-tools";
import { requestModel } from "@zuse/agents/harness/model";
import type { HarnessModelOutput } from "@zuse/agents/harness/types";
import { AttachmentService } from "@zuse/agents/kernel/attachment-service";
import { makeTurnScopedSessionHandle } from "@zuse/agents/kernel/turn-protocol";
import {
	type AgentEvent,
	AgentSessionId,
	AgentTurnId,
	FolderId,
} from "@zuse/contracts";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { AppPaths } from "../../src/app-paths.ts";
import { ConfigStoreServiceLive } from "../../src/config-store/layers/config-store-service.ts";
import { ConfigStoreService } from "../../src/config-store/services/config-store-service.ts";
import { ModelConnections } from "../../src/harness/connections-service.ts";
import {
	HarnessProvider,
	HarnessProviderLive,
} from "../../src/harness/provider.ts";
import { Migration0061HarnessExecutions } from "../../src/persistence/migrations/0061_harness_executions.ts";
import {
	PermissionService,
	type RequestOptions,
} from "../../src/provider/services/permission-service.ts";

vi.mock("@zuse/agents/harness/model", async (importOriginal) => ({
	...(await importOriginal<typeof import("@zuse/agents/harness/model")>()),
	requestModel: vi.fn(),
}));
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});
async function setup(
	contextWindow?: number,
	autoCompactTokenLimit?: number,
	simulatorClient?: SimulatorToolsClient,
) {
	const dir = await mkdtemp(join(tmpdir(), "zuse-provider-test-"));
	vi.stubEnv("ZUSE_CONFIG_DIR", join(dir, "config"));
	const fetcher = vi.fn(async () =>
		Response.json({
			models: [
				{
					slug: "test-model",
					display_name: "Test model",
					visibility: "list",
					...(contextWindow === undefined
						? {}
						: {
								context_window: contextWindow,
								auto_compact_token_limit: autoCompactTokenLimit,
							}),
				},
				{ slug: "hidden", visibility: "hidden" },
			],
		}),
	);
	vi.stubGlobal("fetch", fetcher);
	let connectionAccess = true;
	const auth = ModelConnections.of({
		status: () =>
			Effect.succeed({
				available: connectionAccess,
				connections: [
					{
						id: "connection-one",
						clientId: "test",
						provider: "chatgpt",
						name: "Test",
						createdAt: 1,
						preferred: true,
						authorized: true,
						status: "connected",
						planNoticeSeen: true,
					},
				],
			}),
		credential: () =>
			Effect.succeed({
				connectionId: "connection-one",
				accessToken: "test-secret",
				provider: "chatgpt",
			}),
		connect: () => Stream.empty,
		rename: () => Effect.void,
		preferred: () => Effect.void,
		disconnect: () => Effect.succeed({ revoked: true }),
		acknowledgePlan: () => Effect.void,
	});
	const requestPermission = vi.fn(() =>
		Effect.succeed({ _tag: "AllowOnce" as const }),
	);
	const paths = Layer.succeed(AppPaths, { userData: dir });
	const config = ConfigStoreServiceLive.pipe(
		Layer.provide(paths),
		Layer.provide(NodeServices.layer),
	);
	const deps = Layer.mergeAll(
		paths,
		config,
		sqliteLayer({ filename: join(dir, "runtime.sqlite") }),
		Layer.succeed(ModelConnections, auth),
		Layer.succeed(AttachmentService, {
			upload: () => Effect.die("unused"),
			saveText: () => Effect.die("unused"),
			read: () => Effect.succeed(null),
			readPath: () => Effect.succeed(null),
			readForSession: () => Effect.succeed(null),
		}),
		Layer.succeed(PermissionService, {
			request: requestPermission,
			decide: () => Effect.void,
			listPending: () => Effect.succeed([]),
			requests: () => Stream.empty,
			listDecisions: () => Effect.succeed([]),
			revokeDecision: () => Effect.void,
		}),
	);
	const runtime = ManagedRuntime.make(
		HarnessProviderLive.pipe(
			Layer.provideMerge(deps),
			Layer.provide(
				simulatorClient
					? Layer.succeed(SimulatorTools, simulatorClient)
					: Layer.empty,
			),
		),
	);
	await runtime.runPromise(Migration0061HarnessExecutions);
	const provider = await runtime.runPromise(HarnessProvider);
	const configService = await runtime.runPromise(ConfigStoreService);
	const settings = await runtime.runPromise(configService.getSettings());
	const enable = (enabled: boolean) =>
		runtime.runPromise(
			configService.updateSettings({
				providerEnabled: { ...settings.providerEnabled, zuse: enabled },
			}),
		);
	const input = {
		sessionId: AgentSessionId.make("test-session"),
		folderId: FolderId.make("project"),
		providerId: "zuse" as const,
		mode: "sdk" as const,
		model: "chatgpt/test-model",
		modelOptions: { reasoning: "medium" },
	};
	const start = (
		cursor: string | null = null,
		authority?: Pick<RequestOptions, "owner" | "isCurrent">,
		orchestration?: OrchestrationSessionTools,
		executionEnv?: Readonly<Record<string, string>>,
	) =>
		runtime.runPromise(
			provider.start(
				{ ...input, executionEnv },
				dir,
				input.sessionId,
				cursor,
				() => "approval-required",
				authority,
				orchestration,
			),
		);
	return {
		dir,
		runtime,
		provider,
		start,
		enable,
		fetcher,
		requestPermission,
		setConnectionAccess: (allowed: boolean) => {
			connectionAccess = allowed;
		},
		close: async () => {
			await runtime.dispose();
			await rm(dir, { recursive: true, force: true });
		},
	};
}
const output = (text: string): HarnessModelOutput => ({
	messages: [{ role: "assistant", content: text }],
	text,
	calls: [],
	inputTokens: 20,
	outputTokens: 5,
	connectionId: "connection-one",
});
const tool = (
	name: string,
	id: string,
	input: unknown,
): HarnessModelOutput => ({
	...output(""),
	messages: [
		{
			role: "assistant",
			content: [{ type: "tool-call", toolCallId: id, toolName: name, input }],
		},
	],
	calls: [{ id, name, input }],
});
it("edits and runs bash through the provider handle, streams, and resumes without repeating completed tools", async () => {
	const env = await setup();
	try {
		await expect(env.start()).rejects.toMatchObject({
			reason: "Enable Zuse (Experimental) in Agent providers first.",
		});
		await env.enable(true);
		expect(
			(await env.runtime.runPromise(env.provider.availability())).authStatus,
		).toBe("authenticated");
		const [models] = await Promise.all([
			env.runtime.runPromise(env.provider.inventory()),
			env.runtime.runPromise(env.provider.inventory()),
		]);
		expect(models).toEqual([{ id: "chatgpt/test-model", label: "Test model" }]);
		expect(env.fetcher).toHaveBeenCalledTimes(1);
		const model = vi.mocked(requestModel);
		model
			.mockImplementationOnce(async (input, credential) => {
				expect(input.model).toBe("test-model");
				expect(input.reasoning).toBe("medium");
				expect(credential.accessToken).toBe("test-secret");
				input.onText("I will ");
				input.onText("write and test.");
				return tool("write_file", "write-once", {
					path: "hello.txt",
					content: "hello",
					expected_hash: null,
				});
			})
			.mockImplementationOnce(async () =>
				tool("exec_command", "shell-once", {
					command: "cat hello.txt",
					yield_time_ms: 1000,
				}),
			)
			.mockImplementation(async (input) => {
				input.onText("Done");
				return output("Done");
			});
		const authority = {
			owner: { providerSessionId: "harness-residency" },
			isCurrent: Effect.succeed(true),
		};
		const handle = await env.runtime.runPromise(
			makeTurnScopedSessionHandle(await env.start(null, authority)),
		);
		const events: AgentEvent[] = [];
		const reading = env.runtime.runPromise(
			Stream.runForEach(handle.events, (e) =>
				Effect.sync(() => {
					if (e.event._tag !== "QuestionCallbackReleased") events.push(e.event);
				}),
			),
		);
		await env.runtime.runPromise(
			handle.send(AgentTurnId.make("turn-one"), "Write hello and test"),
		);
		await expect
			.poll(() => events.some((e) => e._tag === "Completed"), { timeout: 5000 })
			.toBe(true);
		expect(await readFile(join(env.dir, "hello.txt"), "utf8")).toBe("hello");
		expect(env.requestPermission).toHaveBeenCalledTimes(2);
		expect(env.requestPermission).toHaveBeenCalledWith(
			AgentSessionId.make("test-session"),
			expect.anything(),
			expect.objectContaining(authority),
		);
		expect(events).toContainEqual(
			expect.objectContaining({ _tag: "ToolUse", tool: "Bash" }),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				_tag: "AssistantMessage",
				text: "I will write and test.",
				checkpoint: expect.objectContaining({ final: true }),
			}),
		);
		expect(JSON.stringify(events)).not.toContain("test-secret");
		expect(
			events.filter((e) => e._tag === "AssistantMessage").map((e) => e.text),
		).not.toContain("Using connection: Test");
		await env.runtime.runPromise(handle.close());
		await reading;
		const restored = await env.start("zuse:test-session");
		const resumed: AgentEvent[] = [];
		const collecting = env.runtime.runPromise(
			Stream.runForEach(restored.events, (e) =>
				Effect.sync(() => {
					if (e._tag !== "QuestionCallbackReleased") resumed.push(e);
				}),
			),
		);
		model.mockImplementationOnce(async (input) => {
			expect(JSON.stringify(input.messages)).toContain("write-once");
			expect(JSON.stringify(input.messages)).toContain("shell-once");
			return output("Remembered");
		});
		await env.runtime.runPromise(restored.send("What did you do?"));
		await expect
			.poll(() => resumed.some((e) => e._tag === "Completed"))
			.toBe(true);
		expect(env.requestPermission).toHaveBeenCalledTimes(2);
		await env.runtime.runPromise(restored.close());
		await collecting;
	} finally {
		await env.close();
	}
});
it("Stop aborts inference and disabling prevents further requests", async () => {
	const env = await setup();
	try {
		await env.enable(true);
		let started = false;
		vi.mocked(requestModel).mockImplementationOnce(
			(input) =>
				new Promise((_, reject) => {
					started = true;
					input.signal.addEventListener(
						"abort",
						() => reject(new Error("aborted")),
						{ once: true },
					);
				}),
		);
		const handle = await env.start();
		const events: AgentEvent[] = [];
		const reading = env.runtime.runPromise(
			Stream.runForEach(handle.events, (e) =>
				Effect.sync(() => {
					if (e._tag !== "QuestionCallbackReleased") events.push(e);
				}),
			),
		);
		await env.runtime.runPromise(handle.send("Start"));
		await expect.poll(() => started).toBe(true);
		await env.runtime.runPromise(handle.interrupt());
		await expect
			.poll(() => events.some((e) => e._tag === "Interrupted"))
			.toBe(true);
		await env.enable(false);
		await env.runtime.runPromise(handle.send("Again"));
		await expect
			.poll(() =>
				events.some((e) => e._tag === "Completed" && e.reason === "error"),
			)
			.toBe(true);
		expect(requestModel).toHaveBeenCalledTimes(1);
		await env.runtime.runPromise(handle.close());
		await reading;
	} finally {
		await env.close();
	}
});

it("routes child questions and completion into the parent chat", async () => {
	const env = await setup();
	try {
		await env.enable(true);
		const steps = new Map<string, number>();
		vi.mocked(requestModel).mockImplementation(async (input) => {
			const step = steps.get(input.agentId) ?? 0;
			steps.set(input.agentId, step + 1);
			if (input.agentId === input.rootId) {
				if (step === 0)
					return tool("spawn_agent", "spawn-child", {
						name: "Reviewer",
						message: "Review the task",
						inherit: true,
					});
				input.onText("Parent synthesis");
				return output("Parent synthesis");
			}
			if (step === 0)
				return tool("request_user_input", "child-question", {
					question: "Which check?",
					options: ["Tests", "Types"],
				});
			input.onText("Child done");
			return output("Child done");
		});
		const handle = await env.start();
		const events: AgentEvent[] = [];
		const reading = env.runtime.runPromise(
			Stream.runForEach(handle.events, (e) =>
				Effect.sync(() => {
					if (e._tag !== "QuestionCallbackReleased") events.push(e);
				}),
			),
		);
		await env.runtime.runPromise(handle.send("Delegate a review"));
		await expect
			.poll(() => events.some((e) => e._tag === "UserQuestion"))
			.toBe(true);
		const question = events.find((e) => e._tag === "UserQuestion");
		if (question?._tag !== "UserQuestion") throw new Error("Missing question");
		expect(question.parentItemId).toBe("spawn-child");
		await env.runtime.runPromise(
			handle.answerQuestion(question.itemId, [
				{ questionIndex: 0, selected: [0] },
			]),
		);
		await expect
			.poll(() => events.some((e) => e._tag === "Completed"))
			.toBe(true);
		expect(events).toContainEqual(
			expect.objectContaining({
				_tag: "SubagentSummary",
				agentName: "Reviewer",
				itemId: "spawn-child",
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				_tag: "AssistantMessage",
				parentItemId: "spawn-child",
				text: "Child done",
			}),
		);
		expect(events.filter((e) => e._tag === "Completed")).toHaveLength(1);
		await env.runtime.runPromise(handle.close());
		await reading;
	} finally {
		await env.close();
	}
});

it("streams compaction progress and estimated context through the chat protocol", async () => {
	const env = await setup(250_000, 20_000);
	try {
		await env.enable(true);
		let requests = 0;
		vi.mocked(requestModel).mockImplementation(async (input) => {
			requests++;
			if (Object.keys(input.tools).length === 0)
				return output(
					"Task remains active; the earlier response contains no outstanding tool calls.",
				);
			const text =
				requests === 1 ? "large previous response ".repeat(5000) : "continued";
			input.onText(text);
			return output(text);
		});
		const handle = await env.start();
		const events: AgentEvent[] = [];
		const reading = env.runtime.runPromise(
			Stream.runForEach(handle.events, (event) =>
				Effect.sync(() => {
					if (event._tag !== "QuestionCallbackReleased") events.push(event);
				}),
			),
		);
		await env.runtime.runPromise(handle.send("Start task"));
		await expect
			.poll(() => events.filter((e) => e._tag === "Completed").length)
			.toBe(1);
		await env.runtime.runPromise(handle.send("Continue task"));
		await expect
			.poll(() => events.filter((e) => e._tag === "Completed").length)
			.toBe(2);
		const compactions = events.filter((e) => e._tag === "ContextCompaction");
		expect(compactions.map((e) => e.status)).toEqual([
			"in_progress",
			"completed",
		]);
		expect(compactions[0]?.itemId).toBe(compactions[1]?.itemId);
		expect(events).toContainEqual(
			expect.objectContaining({
				_tag: "ContextUsage",
				providerId: "zuse",
				precision: "estimated",
				windowTokens: 237500,
			}),
		);
		expect(events.some((e) => e._tag === "Error")).toBe(false);
		await env.runtime.runPromise(handle.close());
		await reading;
	} finally {
		await env.close();
	}
});

it.each([
	250_000, 1_000_000,
])("uses the account-reported %i context window instead of compacting at 27K", async (contextWindow) => {
	const env = await setup(contextWindow);
	try {
		await env.enable(true);
		const models = await env.runtime.runPromise(env.provider.inventory());
		expect(models[0]?.liveMeta?.contextWindowTokens).toBe(contextWindow);
		let requests = 0;
		vi.mocked(requestModel).mockImplementation(async (input) => {
			expect(Object.keys(input.tools).length).toBeGreaterThan(0);
			requests++;
			return output(requests === 1 ? "a".repeat(81000) : "done");
		});
		const handle = await env.start();
		const events: AgentEvent[] = [];
		const reading = env.runtime.runPromise(
			Stream.runForEach(handle.events, (event) =>
				Effect.sync(() => {
					if (event._tag !== "QuestionCallbackReleased") events.push(event);
				}),
			),
		);
		await env.runtime.runPromise(handle.send("Start task"));
		await expect
			.poll(() => events.filter((e) => e._tag === "Completed").length)
			.toBe(1);
		await env.runtime.runPromise(handle.send("Continue"));
		await expect
			.poll(() => events.filter((e) => e._tag === "Completed").length)
			.toBe(2);
		expect(events.some((e) => e._tag === "ContextCompaction")).toBe(false);
		expect(events).toContainEqual(
			expect.objectContaining({
				_tag: "ContextUsage",
				windowTokens: Math.floor(contextWindow * 0.95),
			}),
		);
		expect(requests).toBe(2);
		await env.runtime.runPromise(handle.close());
		await reading;
	} finally {
		await env.close();
	}
});

it("denies new and resumed harness execution despite saved enablement when account access is revoked", async () => {
	const env = await setup();
	try {
		await env.enable(true);
		env.setConnectionAccess(false);
		expect(
			await env.runtime.runPromise(env.provider.availability()),
		).toMatchObject({ runtimeAvailable: false, status: "disabled" });
		for (const cursor of [null, "zuse:test-session"]) {
			await expect(env.start(cursor)).rejects.toMatchObject({
				reason:
					"Zuse Experimental is not available for this signed-in account.",
			});
		}
		expect(env.fetcher).not.toHaveBeenCalled();
	} finally {
		await env.close();
	}
});

it("own harness exposes app orchestration alongside native tools with shared approvals", async () => {
	const env = await setup();
	try {
		await env.enable(true);
		const delegated = vi.fn(async () => ({ ok: true, taskId: "child" }));
		const deps = {
			delegateTask: delegated,
		} as unknown as OrchestrationToolDeps;
		vi.mocked(requestModel)
			.mockImplementationOnce(async (input) => {
				expect(input.tools).toHaveProperty("delegate_task");
				expect(input.tools).toHaveProperty("schedule_task");
				expect(input.tools).toHaveProperty("request_secret");
				expect(input.tools).toHaveProperty("spawn_agent");
				expect(input.tools).toHaveProperty("exec_command");
				return tool("delegate_task", "delegate-one", {
					task: "review",
					clientRequestId: "stable",
				});
			})
			.mockResolvedValue(output("done"));
		const handle = await env.start(null, undefined, {
			deps,
			claudeTools: buildOrchestrationTools(deps),
		});
		try {
			await env.runtime.runPromise(handle.send("delegate a review"));
			await expect
				.poll(() => delegated.mock.calls.length, { timeout: 3000 })
				.toBe(1);
			expect(env.requestPermission).toHaveBeenCalledWith(
				AgentSessionId.make("test-session"),
				expect.objectContaining({ tool: "delegate_task" }),
				expect.anything(),
			);
		} finally {
			await env.runtime.runPromise(handle.close());
		}
	} finally {
		await env.close();
	}
});

it("passes session environment bindings to native shell without changing process environment", async () => {
	const env = await setup();
	const original = process.env.ZUSE_TEST_PRIVATE_BINDING;
	try {
		await env.enable(true);
		const model = vi.mocked(requestModel);
		model
			.mockImplementationOnce(async () =>
				tool("exec_command", "private-env", {
					command:
						'test "$ZUSE_TEST_PRIVATE_BINDING" = "session-only" && printf binding-present',
					yield_time_ms: 1000,
				}),
			)
			.mockImplementation(async (input) => {
				expect(JSON.stringify(input.messages)).toContain("binding-present");
				expect(JSON.stringify(input.messages)).not.toContain(
					'"ZUSE_TEST_PRIVATE_BINDING":"session-only"',
				);
				return output("done");
			});
		const handle = await env.start(null, undefined, undefined, {
			ZUSE_TEST_PRIVATE_BINDING: "session-only",
		});
		try {
			await env.runtime.runPromise(handle.send("check the binding"));
			await expect
				.poll(() => model.mock.calls.length, { timeout: 3000 })
				.toBe(2);
			expect(process.env.ZUSE_TEST_PRIVATE_BINDING).toBe(original);
		} finally {
			await env.runtime.runPromise(handle.close());
		}
	} finally {
		await env.close();
	}
});

it("exposes and executes device tools through the native provider model loop", async () => {
	const call = vi.fn(async () => ({
		content: [{ type: "text" as const, text: '{"devices":[]}' }],
	}));
	const env = await setup(undefined, undefined, { call });
	try {
		await env.enable(true);
		vi.mocked(requestModel)
			.mockImplementationOnce(async (input) => {
				expect(input.tools.device_list).toBeDefined();
				expect(input.tools.device_open).toBeDefined();
				return tool("device_list", "device-list", {});
			})
			.mockImplementationOnce(async () => output("Devices checked"));
		const handle = await env.runtime.runPromise(
			makeTurnScopedSessionHandle(await env.start()),
		);
		const events: AgentEvent[] = [];
		const reading = env.runtime.runPromise(
			Stream.runForEach(handle.events, (event) =>
				Effect.sync(() => {
					if (event.event._tag !== "QuestionCallbackReleased")
						events.push(event.event);
				}),
			),
		);
		await env.runtime.runPromise(
			handle.send(AgentTurnId.make("device-turn"), "List devices"),
		);
		await expect
			.poll(() => events.some((event) => event._tag === "Completed"), {
				timeout: 5000,
			})
			.toBe(true);
		expect(call).toHaveBeenCalledWith(
			"test-session",
			"device_list",
			{},
			expect.any(AbortSignal),
		);
		expect(env.requestPermission).not.toHaveBeenCalled();
		await env.runtime.runPromise(handle.close());
		await reading;
	} finally {
		await env.close();
	}
});
