import { CloudCommandTerminalError } from "@zuse/client-runtime/client-persistence";
import { deriveSessionPresentation } from "@zuse/client-runtime/session-presentation";
import {
	AgentTurnId,
	AttemptId,
	ComposerInput,
	EnvironmentId,
	Message,
	MessageId,
	QueuedMessage,
	QueuedMessageNotFoundError,
	QueueState,
	SessionId,
	SessionInputBlockedError,
	SessionNotFoundError,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { Effect, Queue, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearPendingSessionMessage,
	mergePendingSessionMessages,
	pendingSessionMessages,
	usePendingSessionMessages,
} from "../../src/lib/pending-session-messages.ts";
import { registerWebSocketEnvironment } from "../../src/lib/rpc-client.ts";

import {
	classifyError,
	classifyMessage,
	compactAndContinueSession,
	isRecoveredPreAckSessionError,
	optimisticQueuedMessageReady,
	pendingSessionCommandError,
	persistQueuedMessage,
	queueSessionMessage,
	retryLastSessionMessage,
	runQueuedMessageNext,
	sendSessionMessage,
	stageSessionMessage,
	updateQueuedMessage,
} from "../../src/lib/session-actions.ts";
import {
	getRendererClientBus,
	registerSessionTimelineCheckpointSynchronizer,
	resetSessionTimelineClientBusForTest,
	retainSessionTimeline,
	setSessionTimelineRpcClientForTest,
} from "../../src/lib/session-timeline-client-bus.ts";

const waitUntil = async (predicate: () => boolean): Promise<void> => {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not reached");
};

const environmentId = EnvironmentId.make("session-actions-environment");
const sessionId = SessionId.make("session-actions-session");
const ref = { environmentId, sessionId } as const;

describe("session actions", () => {
	beforeEach(() =>
		registerWebSocketEnvironment(environmentId, "wss://example.test/rpc"),
	);
	afterEach(() => {
		resetSessionTimelineClientBusForTest();
		usePendingSessionMessages.setState({ byResource: {} });
	});

	it.each([
		{ action: retryLastSessionMessage, resumeFails: false },
		{ action: retryLastSessionMessage, resumeFails: true },
		{ action: compactAndContinueSession, resumeFails: false },
		{ action: compactAndContinueSession, resumeFails: true },
	])("resumes an unresolved failed turn without submitting a duplicate ($action.name, resume failure: $resumeFails)", async ({
		action,
		resumeFails,
	}) => {
		const frames = Effect.runSync(Queue.unbounded());
		let resumes = 0;
		let sends = 0;
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"session.events": () => Stream.fromQueue(frames),
					"session.resume": () =>
						Effect.sync(() => {
							resumes += 1;
						}).pipe(
							Effect.andThen(
								resumeFails
									? Effect.fail(new SessionNotFoundError({ sessionId }))
									: Effect.void,
							),
						),
					"messages.send": () =>
						Effect.sync(() => {
							sends += 1;
						}),
				}) as never,
		);
		const retained = retainSessionTimeline(ref, "connect");
		await new Promise((resolve) => setTimeout(resolve, 0));
		Queue.offerUnsafe(frames, {
			kind: "snapshot",
			sessionId,
			throughVersion: 0,
			cursor: { epoch: "retry-epoch", version: 0 },
			projection: SessionTimelineProjection.make({
				messages: [
					Message.make({
						id: MessageId.make("failed-message"),
						sessionId,
						role: "user",
						content: { _tag: "user", text: "continue the review", goal: false },
						createdAt: new Date(),
					}),
				],
				status: "error",
				turnCount: 1,
				activeTurn: {
					id: AgentTurnId.make("failed-turn"),
					ordinal: 1,
					status: "running",
					phase: "running",
					attempt: {
						id: AttemptId.make("attempt-1"),
						ordinal: 1,
						reason: "initial",
					},
					providerThreadId: null,
					requestedAt: new Date(0),
					completedAt: null,
				},
				queue: QueueState.make({ items: [], paused: false }),
				permissionMode: "default",
				runtimeMode: "approval-required",
			}),
		});
		await waitUntil(
			() =>
				getRendererClientBus().snapshot(retained.key).data?.status === "error",
		);
		expect(await action(ref)).toBe(!resumeFails);
		expect(resumes).toBe(1);
		expect(sends).toBe(0);
		expect(pendingSessionMessages(ref)).toEqual([]);
		retained.lease.release();
	});

	it("classifies provider authentication failures once at the boundary", () => {
		expect(classifyMessage("401 unauthorized", "codex")).toEqual({
			kind: "auth",
			providerId: "codex",
			message: "401 unauthorized",
		});
	});

	it("classifies broker reconnects as Codex authentication", () => {
		expect(classifyMessage("codex-auth-reconnect-required", "codex")).toEqual({
			kind: "auth",
			providerId: "codex",
			message: "codex-auth-reconnect-required",
		});
	});

	it("classifies account-broker reconnects for every cloud provider", () => {
		for (const providerId of ["claude", "cursor", "grok"] as const)
			expect(
				classifyMessage(`${providerId}-auth-reconnect-required`, providerId),
			).toEqual({
				kind: "auth",
				providerId,
				message: `${providerId}-auth-reconnect-required`,
			});
	});

	it("classifies reconnect failures without clearing canonical data", () => {
		expect(
			classifyMessage("WebSocket closed while the laptop was offline"),
		).toEqual({
			kind: "network",
			message: "WebSocket closed while the laptop was offline",
		});
	});

	it("classifies terminal cloud lifecycle failures without exposing internals", () => {
		expect(
			classifyError(
				new CloudCommandTerminalError(
					"cancelled",
					"workspace-deleted",
					"This workspace was archived or deleted before the command was accepted.",
				),
			),
		).toEqual({
			kind: "terminal",
			category: "workspace-deleted",
			headline: "Workspace unavailable",
			message:
				"This workspace was archived or deleted before the command could finish.",
		});
	});

	it("presents Codex authentication and missing sessions as typed actions", () => {
		expect(
			classifyMessage("codex: Auth(AuthorizationRequired)", "codex"),
		).toEqual({
			kind: "auth",
			providerId: "codex",
			message: "codex: Auth(AuthorizationRequired)",
		});
		expect(classifyError(new SessionNotFoundError({ sessionId }))).toEqual({
			kind: "terminal",
			category: "session-unavailable",
			headline: "Session unavailable",
			message: "This chat session is no longer available in the agent runtime.",
		});
	});

	it("does not expose a queued message as runnable before its add receipt", () => {
		expect(optimisticQueuedMessageReady()).toBe(false);
		expect(optimisticQueuedMessageReady({ ready: true })).toBe(false);
		expect(optimisticQueuedMessageReady({ persist: false })).toBe(true);
		expect(optimisticQueuedMessageReady({ persist: false, ready: false })).toBe(
			false,
		);
	});

	it("drops a provisional session-not-found error after the timeline is live", () => {
		expect(
			isRecoveredPreAckSessionError("SessionNotFoundError", {
				data: {},
				sync: "live",
			}),
		).toBe(true);
		expect(
			isRecoveredPreAckSessionError("SessionNotFoundError", {
				data: null,
				sync: "synchronizing",
			}),
		).toBe(false);
		expect(
			isRecoveredPreAckSessionError("actual provider failure", {
				data: {},
				sync: "live",
			}),
		).toBe(false);
	});

	it("shows a cloud startup message before uploads finish and replaces its pending attachment in place", () => {
		const input = ComposerInput.make({
			text: "Describe this image",
			fileRefs: [],
			skillRefs: [],
			attachments: [
				{
					id: "pending-image",
					mimeType: "image/png",
					originalName: "screenshot.png",
				},
			],
		});
		const messageId = stageSessionMessage(ref, input);
		const retained = retainSessionTimeline(ref, "cache-only");
		expect(
			getRendererClientBus().snapshot(retained.key).data?.messages,
		).toMatchObject([
			{
				id: messageId,
				content: { text: input.text, attachments: input.attachments },
			},
		]);
		stageSessionMessage(
			ref,
			ComposerInput.make({
				...input,
				attachments: [
					{
						mimeType: "image/png",
						originalName: "screenshot.png",
						id: "uploaded-image",
					},
				],
			}),
			{ messageId },
		);
		expect(
			getRendererClientBus().snapshot(retained.key).data?.messages,
		).toMatchObject([
			{ id: messageId, content: { attachments: [{ id: "uploaded-image" }] } },
		]);
		expect(
			getRendererClientBus().snapshot(retained.key).data?.messages,
		).toHaveLength(1);
		retained.lease.release();
	});
	it("keeps the submitted prompt visible when an empty cloud checkpoint arrives during upload", async () => {
		const unregister = registerSessionTimelineCheckpointSynchronizer(
			environmentId,
			async () => ({
				data: SessionTimelineProjection.make({
					messages: [],
					status: "idle",
					activeTurn: null,
					turnCount: 0,
					queue: QueueState.make({ items: [], paused: false }),
					permissionMode: "default",
					runtimeMode: "approval-required",
				}),
				cursor: { epoch: "startup-checkpoint", version: 0 },
				origin: "checkpoint",
			}),
		);
		const messageId = stageSessionMessage(ref, "Describe this image");
		const retained = retainSessionTimeline(ref, "sync");
		await waitUntil(
			() =>
				getRendererClientBus().snapshot(retained.key).origin === "checkpoint",
		);
		const history =
			getRendererClientBus().snapshot(retained.key).data?.messages ?? [];

		expect(history).toHaveLength(0);
		const visible = mergePendingSessionMessages(
			history,
			pendingSessionMessages(ref),
		);
		expect(visible).toMatchObject([
			{ id: messageId, content: { text: "Describe this image" } },
		]);

		expect(
			mergePendingSessionMessages(visible, pendingSessionMessages(ref)),
		).toHaveLength(1);
		clearPendingSessionMessage(ref, messageId);
		expect(pendingSessionMessages(ref)).toHaveLength(0);
		unregister();
		retained.lease.release();
	});

	it("keeps the composer submission unaccepted after a retryable transport failure", async () => {
		const frames = Effect.runSync(Queue.unbounded());
		let streamStarts = 0;
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"session.events": () => {
						streamStarts += 1;
						return Stream.fromQueue(frames);
					},
					"messages.send": () =>
						Effect.fail({
							_tag: "RpcClientError",
							reason: { _tag: "SocketError", message: "offline" },
						}),
				}) as never,
		);

		const retained = retainSessionTimeline(ref, "connect");
		await waitUntil(() => streamStarts === 1);
		await expect(sendSessionMessage(ref, "keep this draft")).resolves.toBe(
			false,
		);

		const view = getRendererClientBus().snapshot(retained.key);
		expect(view.data?.messages).toHaveLength(1);
		expect(view.data?.messages[0]?.content).toMatchObject({
			_tag: "user",
			text: "keep this draft",
		});
		expect(view.failedCommands).toHaveLength(1);
		expect(view.failedCommands[0]?.retryable).toBe(true);
		retained.lease.release();
	});

	it("clears the optimistic working state when send fails schema validation", async () => {
		const frames = Effect.runSync(Queue.unbounded());
		let streamStarts = 0;
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"session.events": () => {
						streamStarts += 1;
						return Stream.fromQueue(frames);
					},
					"messages.send": () =>
						Effect.fail(
							new Error('Expected providerId, got "acp-custom-provider"'),
						),
				}) as never,
		);
		const retained = retainSessionTimeline(ref, "connect");
		await waitUntil(() => streamStarts === 1);
		await expect(
			sendSessionMessage(ref, "keep this rejected draft"),
		).resolves.toBe(false);
		const view = getRendererClientBus().snapshot(retained.key);
		expect(view.pendingCommands).toEqual([]);
		expect(view.data?.messages).toEqual([]);
		expect(pendingSessionMessages(ref)).toEqual([]);
		expect(view.failedCommands).toHaveLength(1);
		expect(view.failedCommands[0]?.retryable).toBe(false);
		expect(deriveSessionPresentation({ view }).busy).toBe(false);
		retained.lease.release();
	});

	it("converges when a queued message was consumed before its final update", async () => {
		const frames = Effect.runSync(Queue.unbounded());
		let streamStarts = 0;
		const input = ComposerInput.make({
			text: "make pr",
			attachments: [],
			fileRefs: [],
			skillRefs: [],
		});
		const queueId = "queue-consumed-before-update";
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"session.events": () => {
						streamStarts += 1;
						return Stream.fromQueue(frames);
					},
					"messages.queue.update": () =>
						Effect.fail(new QueuedMessageNotFoundError({ sessionId, queueId })),
				}) as never,
		);

		const retained = retainSessionTimeline(ref, "connect");
		await waitUntil(() => streamStarts === 1);
		Queue.offerUnsafe(frames, {
			kind: "snapshot",
			sessionId,
			throughVersion: 0,
			cursor: { epoch: "queue-epoch", version: 0 },
			projection: SessionTimelineProjection.make({
				messages: [],
				status: "idle",
				activeTurn: null,
				turnCount: 0,
				queue: QueueState.make({
					items: [
						QueuedMessage.make({
							id: queueId,
							sessionId,
							input,
							position: 0,
							createdAt: new Date(),
							updatedAt: new Date(),
							ready: false,
						}),
					],
					paused: false,
				}),
				permissionMode: "default",
				runtimeMode: "approval-required",
			}),
		});
		await waitUntil(
			() =>
				getRendererClientBus().snapshot(retained.key).data?.queue.items
					.length === 1,
		);

		await updateQueuedMessage(ref, queueId, input);

		expect(
			getRendererClientBus().snapshot(retained.key).data?.queue.items,
		).toEqual([]);
		expect(
			getRendererClientBus().snapshot(retained.key).failedCommands,
		).toEqual([]);
		expect(pendingSessionCommandError(ref)).toBeNull();
		retained.lease.release();
	});

	it.each([
		"missing",
		"blocked",
	])("removes refused auto-queue without accepting the composer draft (%s)", async (reason) => {
		const frames = Effect.runSync(Queue.unbounded());
		let streamStarts = 0;
		const input = ComposerInput.make({
			text: "deliver after resume",
			attachments: [],
			fileRefs: [],
			skillRefs: [],
		});
		const queueId = "queue-missing-runtime-session";
		setSessionTimelineRpcClientForTest(
			async () =>
				({
					"session.events": () => {
						streamStarts += 1;
						return Stream.fromQueue(frames);
					},
					"messages.queue.add": (payload: { rejectIfBlocked?: boolean }) => {
						expect(payload.rejectIfBlocked).toBe(true);
						return Effect.fail(
							reason === "missing"
								? new SessionNotFoundError({ sessionId })
								: new SessionInputBlockedError({
										sessionId,
										requestId: "question",
										kind: "question",
										message: "Answer the pending request",
									}),
						);
					},
				}) as never,
		);

		const retained = retainSessionTimeline(ref, "connect");
		await waitUntil(() => streamStarts === 1);
		Queue.offerUnsafe(frames, {
			kind: "snapshot",
			sessionId,
			throughVersion: 0,
			cursor: { epoch: "queue-epoch", version: 0 },
			projection: SessionTimelineProjection.make({
				messages: [],
				status: "idle",
				activeTurn: null,
				turnCount: 0,
				queue: QueueState.make({ items: [], paused: false }),
				permissionMode: "default",
				runtimeMode: "approval-required",
			}),
		});
		await waitUntil(
			() =>
				getRendererClientBus().snapshot(retained.key).data?.queue.items
					.length === 0,
		);
		queueSessionMessage(ref, input, { persist: false, ready: false, queueId });
		expect(
			getRendererClientBus().snapshot(retained.key).data?.queue.items,
		).toHaveLength(1);

		expect(
			await persistQueuedMessage(ref, queueId, input, {
				rejectIfBlocked: true,
			}),
		).toBe(false);

		expect(
			getRendererClientBus().snapshot(retained.key).data?.queue.items,
		).toEqual([]);
		if (reason === "missing")
			expect(pendingSessionCommandError(ref)).toMatchObject({
				kind: "terminal",
				category: "session-unavailable",
				headline: "Session unavailable",
				message:
					"This chat session is no longer available in the agent runtime.",
			});
		retained.lease.release();
	});
});

it.each([
	false,
	true,
])("keeps a steer visible until its runtime receipt arrives (rejected: %s)", async (rejected) => {
	const input = ComposerInput.make({
		text: "steer this turn",
		attachments: [],
		fileRefs: [],
		skillRefs: [],
	});
	const item = QueuedMessage.make({
		id: "pending-steer",
		sessionId,
		input,
		position: 0,
		ready: true,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	let acknowledge!: () => void;
	let calls = 0;
	const acknowledgment = new Promise<void>((resolve) => {
		acknowledge = resolve;
	});
	registerWebSocketEnvironment(environmentId, "wss://example.test/rpc");
	setSessionTimelineRpcClientForTest(
		async () =>
			({
				"session.events": () => Stream.never,
				"messages.queue.runNext": () => {
					calls++;
					return Effect.promise(() => acknowledgment).pipe(
						Effect.flatMap(() =>
							rejected
								? Effect.fail(
										new SessionInputBlockedError({
											sessionId,
											requestId: "question",
											kind: "question",
											message: "Answer the pending request",
										}),
									)
								: Effect.void,
						),
					);
				},
			}) as never,
	);
	registerSessionTimelineCheckpointSynchronizer(environmentId, async () => ({
		data: SessionTimelineProjection.make({
			messages: [],
			status: "idle",
			activeTurn: null,
			turnCount: 0,
			queue: QueueState.make({ items: [item], paused: false }),
			permissionMode: "default",
			runtimeMode: "full-access",
		}),
		cursor: { epoch: "steer", version: 1 },
	}));
	const retained = retainSessionTimeline(ref, "sync");
	try {
		await waitUntil(
			() =>
				getRendererClientBus().snapshot(retained.key).data?.queue.items
					.length === 1,
		);
		const sending = runQueuedMessageNext(ref, item.id);
		await waitUntil(() => calls === 1);
		expect(
			getRendererClientBus().snapshot(retained.key).data?.queue.items,
		).toEqual([item]);
		await runQueuedMessageNext(ref, item.id);
		expect(calls).toBe(1);
		acknowledge();
		await sending;
		expect(
			getRendererClientBus().snapshot(retained.key).data?.queue.items,
		).toEqual(rejected ? [item] : []);
	} finally {
		acknowledge();
		retained.lease.release();
		resetSessionTimelineClientBusForTest();
	}
});

it("makes queued feedback steerable while a goal send is awaiting its receipt", async () => {
	resetSessionTimelineClientBusForTest();
	registerWebSocketEnvironment(environmentId, "wss://example.test/rpc");
	let finishGoalSend!: () => void;
	const goalSendReceipt = new Promise<void>((resolve) => {
		finishGoalSend = resolve;
	});
	let goalSendStarted = false;
	let steered = false;
	setSessionTimelineRpcClientForTest(
		async () =>
			({
				"session.events": () => Stream.never,
				"messages.send": () => {
					goalSendStarted = true;
					return Effect.promise(() => goalSendReceipt);
				},
				"messages.queue.add": ({
					queueId,
					input,
				}: {
					queueId: string;
					input: ComposerInput;
				}) =>
					Effect.succeed(
						QueuedMessage.make({
							id: queueId,
							sessionId,
							input,
							position: 0,
							ready: true,
							createdAt: new Date(),
							updatedAt: new Date(),
						}),
					),
				"messages.queue.runNext": () =>
					Effect.sync(() => {
						steered = true;
					}),
			}) as never,
	);
	const retained = retainSessionTimeline(ref, "connect");
	const sending = sendSessionMessage(ref, "finish the goal", { asGoal: true });
	try {
		await waitUntil(() => goalSendStarted);
		const input = ComposerInput.make({
			text: "change direction",
			attachments: [],
			fileRefs: [],
			skillRefs: [],
		});
		const queueId = queueSessionMessage(ref, input, {
			persist: false,
			ready: false,
		});
		const persisting = persistQueuedMessage(ref, queueId, input);
		await expect
			.poll(
				() =>
					getRendererClientBus()
						.snapshot(retained.key)
						.data?.queue.items.find((item) => item.id === queueId)?.ready,
			)
			.toBe(true);
		expect(await persisting).toBe(true);
		await runQueuedMessageNext(ref, queueId);
		expect(steered).toBe(true);
	} finally {
		finishGoalSend();
		retained.lease.release();
		resetSessionTimelineClientBusForTest();
		await sending;
		usePendingSessionMessages.setState({ byResource: {} });
	}
});
