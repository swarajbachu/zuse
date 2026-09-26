import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerNotification } from "@zuse/agents/codex-generated/ServerNotification";
import type { ServerRequest } from "@zuse/agents/codex-generated/ServerRequest";
import {
	type CodexSessionHandle,
	startCodexSession,
} from "@zuse/agents/drivers/codex";
import {
	CodexAppServerClient,
	CodexAppServerRequestError,
} from "@zuse/agents/drivers/codex-app-server-client";
import { AttachmentService } from "@zuse/agents/kernel/attachment-service";
import { makeTurnScopedSessionHandle } from "@zuse/agents/kernel/turn-protocol";
import type {
	AgentSessionId,
	AgentTurnId,
	FolderId,
	StartSessionInput,
} from "@zuse/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderDriverEvent } from "../../../src/kernel/driver.ts";

const AttachmentsTest = Layer.succeed(AttachmentService, {
	upload: () => Effect.die("not used"),
	saveText: () => Effect.die("not used"),
	read: () => Effect.succeed(null),
	readForSession: () => Effect.succeed(null),
	readPath: () => Effect.succeed(null),
});

const input = (
	overrides: Partial<StartSessionInput> = {},
): StartSessionInput => ({
	folderId: "folder-1" as FolderId,
	providerId: "codex",
	mode: "sdk",
	model: "gpt-5.6-sol",
	permissionMode: "default",
	...overrides,
});

let appServerRequest:
	| ((request: ServerRequest, respond: (result: unknown) => void) => void)
	| null = null;
let appServerExit: ((reason: Error) => void) | null = null;

const installAppServer = (
	missingResume: boolean,
	initialMissingMcpInventories = 0,
	terminateOnMcpInventory = false,
) => {
	let mcpInventoryReads = 0;
	let startupTerminated = false;
	let terminate: ((error: Error) => void) | undefined;
	let notify: ((notification: ServerNotification) => void) | undefined;
	vi.spyOn(CodexAppServerClient, "start").mockImplementation(
		async (options) => {
			terminate = options.onUnexpectedTermination;
			notify = options.onNotification;
			appServerRequest = options.onServerRequest;
			appServerExit = options.onUnexpectedTermination ?? null;
			return {
				request: vi.fn(async (method: string, params?: unknown) => {
					const record = (params ?? {}) as Record<string, unknown>;
					switch (method) {
						case "config/mcpServer/reload":
							return {};
						case "mcpServerStatus/list":
							if (terminateOnMcpInventory && !startupTerminated) {
								startupTerminated = true;
								const error = new Error(
									"Codex app-server exited with code 17 during startup",
								);
								options.onUnexpectedTermination?.(error);
								throw error;
							}
							mcpInventoryReads += 1;
							return {
								data: [
									{
										name: "zuse",
										tools:
											mcpInventoryReads <= initialMissingMcpInventories
												? {}
												: {
														ask_user_question: {},
														browser_status: {},
														view_image: {},
													},
									},
								],
							};
						case "collaborationMode/list":
							return { data: [] };
						case "model/list":
							return { data: [] };
						case "thread/goal/get":
							return null;
						case "thread/start":
							options.onNotification({
								method: "thread/started",
								params: { thread: { id: "fresh-thread" } },
							} as never);
							return { thread: { id: "fresh-thread" } };
						case "thread/resume":
							if (missingResume) {
								throw new CodexAppServerRequestError({
									code: -32600,
									message: `no rollout found for thread id ${String(record.threadId)}`,
								});
							}
							options.onNotification({
								method: "thread/started",
								params: { thread: { id: record.threadId } },
							} as never);
							return { thread: { id: record.threadId } };
						case "thread/fork":
							if (missingResume) {
								throw new CodexAppServerRequestError({
									code: -32600,
									message: `no rollout found for thread id ${String(record.threadId)}`,
								});
							}
							options.onNotification({
								method: "thread/started",
								params: { thread: { id: "forked-thread" } },
							} as never);
							return { thread: { id: "forked-thread" } };
						case "turn/start":
							options.onNotification({
								method: "turn/started",
								params: {
									threadId: record.threadId,
									turn: { id: "turn-1" },
								},
							} as never);
							return { turn: { id: "turn-1" } };
						default:
							throw new Error(`Unexpected app-server method: ${method}`);
					}
				}),
				close: vi.fn(),
			} as unknown as CodexAppServerClient;
		},
	);
	return {
		notify: (notification: ServerNotification) => {
			if (notify === undefined) throw new Error("App server is not running");
			notify(notification);
		},
		terminate: (error: Error) => {
			if (terminate === undefined) throw new Error("App server is not running");
			terminate(error);
		},
	};
};

const withSession = async <A>(
	options: {
		readonly resumeCursor?: string | null;
		readonly forkFromResume?: boolean;
		readonly missingResume?: boolean;
		readonly initialMissingMcpInventories?: number;
		readonly terminateOnMcpInventory?: boolean;
		readonly onUnexpectedTermination?: (error: Error) => void;
	},
	use: (
		handle: CodexSessionHandle,
		appServer: ReturnType<typeof installAppServer>,
	) => Promise<A>,
): Promise<A> => {
	const cwd = mkdtempSync(join(tmpdir(), "zuse-codex-lifecycle-"));
	try {
		const appServer = installAppServer(
			options.missingResume ?? false,
			options.initialMissingMcpInventories ?? 0,
			options.terminateOnMcpInventory ?? false,
		);
		const handle = await Effect.runPromise(
			startCodexSession(
				input({ forkFromResume: options.forkFromResume }),
				cwd,
				null,
				"fake-codex",
				"session-1" as AgentSessionId,
				async () => ({ _tag: "AllowOnce" }),
				() => "full-access",
				async () => ({ id: "browser-test", ok: true }),
				"bun",
				null,
				options.resumeCursor ?? null,
				options.onUnexpectedTermination,
			).pipe(Effect.provide(AttachmentsTest)),
		);
		try {
			return await use(handle, appServer);
		} finally {
			await Effect.runPromise(handle.close());
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
};

const takeEvents = (
	events: Stream.Stream<ProviderDriverEvent>,
	count: number,
): Promise<ReadonlyArray<ProviderDriverEvent>> =>
	Effect.runPromise(
		events.pipe(
			Stream.take(count),
			Stream.runCollect,
			Effect.map((chunk) => Array.from(chunk)),
			Effect.timeout("2 seconds"),
		),
	);

const requestNativeQuestion = (
	itemId: string,
	questions: ReadonlyArray<{
		readonly id: string;
		readonly header: string;
		readonly question: string;
		readonly isOther: boolean;
		readonly isSecret: boolean;
		readonly options: ReadonlyArray<{
			readonly label: string;
			readonly description: string;
		}>;
	}> = [
		{
			id: "choice",
			header: "Choice",
			question: "Continue?",
			isOther: false,
			isSecret: false,
			options: [{ label: "Yes", description: "Continue" }],
		},
	],
): Promise<unknown> =>
	new Promise((resolve) => {
		if (appServerRequest === null) {
			throw new Error("Codex app-server request handler was not installed");
		}
		appServerRequest(
			{
				method: "item/tool/requestUserInput",
				id: 1,
				params: {
					threadId: "thread-1",
					turnId: "turn-1",
					itemId,
					questions: questions.map((question) => ({
						...question,
						options: [...question.options],
					})),
				},
			},
			resolve,
		);
	});

afterEach(() => {
	appServerRequest = null;
	appServerExit = null;
	vi.restoreAllMocks();
});

describe("Codex session cursor persistence", () => {
	it("ends an idle stream once without inventing a turn failure", async () => {
		const onUnexpectedTermination = vi.fn();
		await withSession(
			{ onUnexpectedTermination },
			async (handle, appServer) => {
				const scoped = await Effect.runPromise(
					makeTurnScopedSessionHandle(handle),
				);
				const collected = Effect.runFork(Stream.runCollect(scoped.events));
				appServer.terminate(new Error("idle process exited"));
				appServer.terminate(new Error("duplicate exit signal"));
				const events = await Effect.runPromise(
					Fiber.join(collected).pipe(Effect.timeout("2 seconds")),
				);
				expect(events.some((event) => event.scope === "turn")).toBe(false);
				expect(onUnexpectedTermination).toHaveBeenCalledTimes(1);
				expect(onUnexpectedTermination.mock.calls[0]?.[0].message).toBe(
					"idle process exited",
				);
			},
		);
	});

	it("does not start a compatibility fallback after the HTTP process dies", async () => {
		await expect(
			withSession({ terminateOnMcpInventory: true }, async () => undefined),
		).rejects.toMatchObject({
			reason: expect.stringContaining(
				"Codex app-server exited with code 17 during startup",
			),
		});
		expect(CodexAppServerClient.start).toHaveBeenCalledTimes(1);
	});

	it("continues delivering output after a retryable stream error", async () => {
		await withSession({}, async (handle, appServer) => {
			const scoped = await Effect.runPromise(
				makeTurnScopedSessionHandle(handle),
			);
			const collected = Effect.runFork(Stream.runCollect(scoped.events));
			const turnId = "turn-retry" as AgentTurnId;
			await Effect.runPromise(scoped.send(turnId, "hello"));
			appServer.notify({
				method: "error",
				params: {
					threadId: "fresh-thread",
					turnId: "turn-1",
					willRetry: true,
					error: {
						message: "Reconnecting... 2/5",
						codexErrorInfo: null,
						additionalDetails: null,
					},
				},
			});
			appServer.notify({
				method: "item/agentMessage/delta",
				params: {
					threadId: "fresh-thread",
					turnId: "turn-1",
					itemId: "reply",
					delta: "Recovered response",
				},
			});
			await Effect.runPromise(Effect.sleep("30 millis"));
			await Effect.runPromise(handle.close());
			const events = Array.from(
				await Effect.runPromise(
					Fiber.join(collected).pipe(Effect.timeout("2 seconds")),
				),
			);
			expect(events.some((event) => event.event._tag === "Error")).toBe(false);
			expect(JSON.stringify(events)).toContain("Recovered response");
		});
	});

	it("publishes one terminal error and ends after app-server termination", async () => {
		const onUnexpectedTermination = vi.fn();
		await withSession(
			{ onUnexpectedTermination },
			async (handle, appServer) => {
				const scoped = await Effect.runPromise(
					makeTurnScopedSessionHandle(handle),
				);
				const collected = Effect.runFork(Stream.runCollect(scoped.events));
				const turnId = "turn-crashed" as AgentTurnId;
				await Effect.runPromise(scoped.send(turnId, "hello"));
				await Effect.runPromise(Effect.sleep("30 millis"));

				appServer.terminate(
					new Error(
						"Codex app-server exited with code 17\nCodex stderr (tail):\nfatal marker",
					),
				);
				const events = Array.from(
					await Effect.runPromise(
						Fiber.join(collected).pipe(Effect.timeout("2 seconds")),
					),
				);

				expect(events.slice(-2)).toEqual([
					{
						scope: "turn",
						turnId,
						event: {
							_tag: "Error",
							message:
								"Codex app-server exited with code 17\nCodex stderr (tail):\nfatal marker",
						},
					},
					{
						scope: "turn",
						turnId,
						event: { _tag: "Completed", reason: "error" },
					},
				]);
				expect(onUnexpectedTermination).toHaveBeenCalledTimes(1);
			},
		);
	});

	it("maps native preset and free-text question answers", async () => {
		await withSession({}, async (handle) => {
			const events: ProviderDriverEvent[] = [];
			const subscription = Effect.runFork(
				handle.events.pipe(
					Stream.runForEach((event) =>
						Effect.sync(() => {
							events.push(event);
						}),
					),
				),
			);
			const response = requestNativeQuestion("native-answer", [
				{
					id: "choice",
					header: "Choice",
					question: "Continue?",
					isOther: false,
					isSecret: false,
					options: [
						{ label: "Yes", description: "Continue" },
						{ label: "No", description: "Stop" },
					],
				},
				{
					id: "reason",
					header: "Reason",
					question: "Why?",
					isOther: true,
					isSecret: false,
					options: [],
				},
			]);
			await expect
				.poll(() =>
					events.some(
						(event) =>
							event._tag === "UserQuestion" && event.itemId === "native-answer",
					),
				)
				.toBe(true);

			await Effect.runPromise(
				handle.answerQuestion("native-answer" as never, [
					{ questionIndex: 0, selected: [1] },
					{ questionIndex: 1, selected: [], other: "Because it is safer" },
				]),
			);
			await expect(response).resolves.toEqual({
				answers: {
					choice: { answers: ["No"] },
					reason: { answers: ["Because it is safer"] },
				},
			});
			await Effect.runPromise(Fiber.interrupt(subscription));
		});
	});

	it("releases a native user-question callback on interrupt", async () => {
		await withSession({}, async (handle) => {
			const events: ProviderDriverEvent[] = [];
			const subscription = Effect.runFork(
				handle.events.pipe(
					Stream.runForEach((event) =>
						Effect.sync(() => {
							events.push(event);
						}),
					),
				),
			);
			const response = requestNativeQuestion("native-question");
			await expect
				.poll(() =>
					events.some(
						(event) =>
							event._tag === "UserQuestion" &&
							event.itemId === "native-question",
					),
				)
				.toBe(true);

			await Effect.runPromise(handle.interrupt());
			await expect(response).resolves.toEqual({ answers: {} });
			await expect
				.poll(() =>
					events.some(
						(event) =>
							event._tag === "QuestionCallbackReleased" &&
							event.itemId === "native-question" &&
							event.reason === "cancelled",
					),
				)
				.toBe(true);
			await expect(
				Effect.runPromise(
					handle.answerQuestion("native-question" as never, [
						{ questionIndex: 0, selected: [0] },
					]),
				),
			).rejects.toThrow("No pending user question: native-question");
			await Effect.runPromise(Fiber.interrupt(subscription));
		});
	});

	it("releases a native user-question callback when app-server exits", async () => {
		await withSession({}, async (handle) => {
			const events: ProviderDriverEvent[] = [];
			const subscription = Effect.runFork(
				handle.events.pipe(
					Stream.runForEach((event) =>
						Effect.sync(() => {
							events.push(event);
						}),
					),
				),
			);
			const response = requestNativeQuestion("exit-question");
			await expect
				.poll(() =>
					events.some(
						(event) =>
							event._tag === "UserQuestion" && event.itemId === "exit-question",
					),
				)
				.toBe(true);

			if (appServerExit === null)
				throw new Error("Codex app-server exit handler was not installed");
			appServerExit(new Error("injected transport exit"));
			await expect(response).resolves.toEqual({ answers: {} });
			await expect
				.poll(() =>
					events.some(
						(event) =>
							event._tag === "QuestionCallbackReleased" &&
							event.itemId === "exit-question" &&
							event.reason === "transport_lost",
					),
				)
				.toBe(true);
			await expect(
				Effect.runPromise(
					handle.answerQuestion("exit-question" as never, [
						{ questionIndex: 0, selected: [0] },
					]),
				),
			).rejects.toThrow("No pending user question: exit-question");
			await Effect.runPromise(Fiber.interrupt(subscription));
		});
	});

	it("waits for the process-scoped MCP inventory to finish loading", async () => {
		await withSession({ initialMissingMcpInventories: 1 }, async (handle) => {
			const events = await takeEvents(handle.events, 1);
			expect(events).toMatchObject([{ _tag: "Started" }]);
		});
	});

	it("does not publish a provisional cursor before the first turn", async () => {
		await withSession({}, async (handle) => {
			const events: Array<ProviderDriverEvent> = [];
			const subscription = Effect.runFork(
				handle.events.pipe(
					Stream.runForEach((event) =>
						Effect.sync(() => {
							events.push(event);
						}),
					),
				),
			);
			await Effect.runPromise(Effect.sleep("30 millis"));
			await Effect.runPromise(Fiber.interrupt(subscription));

			expect(events.map((event) => event._tag)).toEqual(["Started"]);
		});
	});

	it("publishes a fresh cursor only after the first turn starts", async () => {
		await withSession({}, async (handle) => {
			await Effect.runPromise(handle.send("hello"));
			const events = await takeEvents(handle.events, 4);

			expect(events.map((event) => event._tag)).toEqual([
				"Started",
				"Status",
				"SessionCursor",
				"Status",
			]);
			expect(events[2]).toMatchObject({
				_tag: "SessionCursor",
				cursor: "fresh-thread",
			});
		});
	});

	it("does not republish an existing resumed cursor", async () => {
		await withSession({ resumeCursor: "resumed-thread" }, async (handle) => {
			await Effect.runPromise(handle.send("continue"));
			const events = await takeEvents(handle.events, 3);

			expect(events.map((event) => event._tag)).toEqual([
				"Started",
				"Status",
				"Status",
			]);
		});
	});

	it("publishes a durable fork as the replacement cursor", async () => {
		await withSession(
			{ resumeCursor: "resumed-thread", forkFromResume: true },
			async (handle) => {
				const events = await takeEvents(handle.events, 2);

				expect(events[1]).toMatchObject({
					_tag: "SessionCursor",
					cursor: "forked-thread",
				});
			},
		);
	});

	it("replaces a stale cursor when its rollout is missing", async () => {
		await withSession(
			{ resumeCursor: "stale-thread", missingResume: true },
			async (handle) => {
				await Effect.runPromise(handle.send("recover"));
				const events = await takeEvents(handle.events, 4);

				expect(events.map((event) => event._tag)).toEqual([
					"Started",
					"Status",
					"SessionCursor",
					"Status",
				]);
				expect(events[2]).toMatchObject({
					_tag: "SessionCursor",
					cursor: "fresh-thread",
				});
			},
		);
	});

	it("replaces a stale fork source when its rollout is missing", async () => {
		await withSession(
			{
				resumeCursor: "stale-thread",
				forkFromResume: true,
				missingResume: true,
			},
			async (handle) => {
				await Effect.runPromise(handle.send("recover"));
				const events = await takeEvents(handle.events, 4);

				expect(events[2]).toMatchObject({
					_tag: "SessionCursor",
					cursor: "fresh-thread",
				});
			},
		);
	});

	it("handles /fork before the first turn without persisting a cursor", async () => {
		await withSession({ missingResume: true }, async (handle) => {
			await Effect.runPromise(handle.send("/fork"));
			const events = await takeEvents(handle.events, 2);

			expect(events).toMatchObject([
				{ _tag: "Started" },
				{
					_tag: "AssistantMessage",
					text: "Started a fresh Codex thread.",
				},
			]);
		});
	});
});
