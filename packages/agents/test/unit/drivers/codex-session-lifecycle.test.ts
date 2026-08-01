import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CodexSessionHandle,
	startCodexSession,
} from "@zuse/agents/drivers/codex";
import {
	CodexAppServerClient,
	CodexAppServerRequestError,
} from "@zuse/agents/drivers/codex-app-server-client";
import { AttachmentService } from "@zuse/agents/kernel/attachment-service";
import type {
	AgentEvent,
	AgentSessionId,
	FolderId,
	StartSessionInput,
} from "@zuse/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

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

const installAppServer = (missingResume: boolean) => {
	vi.spyOn(CodexAppServerClient, "start").mockImplementation(
		async (options) =>
			({
				request: vi.fn(async (method: string, params?: unknown) => {
					const record = (params ?? {}) as Record<string, unknown>;
					switch (method) {
						case "config/mcpServer/reload":
							return {};
						case "mcpServerStatus/list":
							return {
								data: [
									{
										name: "zuse",
										tools: {
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
			}) as unknown as CodexAppServerClient,
	);
};

const withSession = async <A>(
	options: {
		readonly resumeCursor?: string | null;
		readonly forkFromResume?: boolean;
		readonly missingResume?: boolean;
	},
	use: (handle: CodexSessionHandle) => Promise<A>,
): Promise<A> => {
	const cwd = mkdtempSync(join(tmpdir(), "zuse-codex-lifecycle-"));
	try {
		installAppServer(options.missingResume ?? false);
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
			).pipe(Effect.provide(AttachmentsTest)),
		);
		try {
			return await use(handle);
		} finally {
			await Effect.runPromise(handle.close());
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
};

const takeEvents = (
	events: Stream.Stream<AgentEvent>,
	count: number,
): Promise<ReadonlyArray<AgentEvent>> =>
	Effect.runPromise(
		events.pipe(
			Stream.take(count),
			Stream.runCollect,
			Effect.map((chunk) => Array.from(chunk)),
			Effect.timeout("2 seconds"),
		),
	);

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Codex session cursor persistence", () => {
	it("does not publish a provisional cursor before the first turn", async () => {
		await withSession({}, async (handle) => {
			const events: Array<AgentEvent> = [];
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
