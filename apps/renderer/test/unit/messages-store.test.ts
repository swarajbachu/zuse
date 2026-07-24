import type { ConnectionSnapshot } from "@zuse/client-runtime/supervisor";
import {
	AgentTurnId,
	ComposerInput,
	Message,
	MessageId,
	QueuedMessage,
	QueueState,
	type SessionId,
	type SessionTimelineFrame,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { Effect, Queue, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reportRendererRpcStreamFailure, subscribeRendererRpcConnection } =
	vi.hoisted(() => ({
		reportRendererRpcStreamFailure: vi.fn(),
		subscribeRendererRpcConnection: vi.fn(),
	}));

vi.mock("../../src/lib/rpc-client.ts", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../src/lib/rpc-client.ts")>();
	return {
		...original,
		reportRendererRpcStreamFailure,
		subscribeRendererRpcConnection,
	};
});

const {
	acknowledgeTimelineSessionCreated,
	deferTimelineUntilSessionCreated,
	setMessagesRpcClientForTest,
	setMessagesRpcCommandDispatcherForTest,
	teardownLiveStreams,
	useMessagesStore,
} = await import("../../src/store/messages.ts");

const sessionId = "session-queue" as SessionId;
const input = new ComposerInput({
	text: "queued",
	attachments: [],
	fileRefs: [],
	skillRefs: [],
});

const queued = QueuedMessage.make({
	id: "q_1",
	sessionId,
	input,
	position: 0,
	createdAt: new Date("2026-06-21T00:00:00.000Z"),
	updatedAt: new Date("2026-06-21T00:00:00.000Z"),
});

const externalMessageEvent = (
	sequence: number,
	messageId: string,
	text: string,
): SessionTimelineFrame => ({
	kind: "event",
	eventId: `event-${messageId}`,
	sessionId,
	streamVersion: sequence,
	event: {
		_tag: "MessagePersisted",
		message: Message.make({
			id: MessageId.make(messageId),
			sessionId,
			role: "assistant",
			content: { _tag: "assistant", text },
			createdAt: new Date(
				new Date("2026-06-21T00:00:01.000Z").getTime() + sequence,
			),
		}),
	},
});

const timelineSnapshot = (throughVersion = 0): SessionTimelineFrame => ({
	kind: "snapshot",
	sessionId,
	throughVersion,
	projection: SessionTimelineProjection.make({
		messages: [],
		status: "running",
		currentTurn: null,
		queue: QueueState.make({ items: [], paused: false }),
		permissionMode: "default",
		runtimeMode: "approval-required",
	}),
});

let interruptCalls = 0;
let sendNowCalls: Array<{
	readonly sessionId: SessionId;
	readonly queueId: string;
}> = [];
let resumeCalls: Array<{ readonly sessionId: SessionId }> = [];
let flushCalls: Array<{ readonly sessionId: SessionId }> = [];
let addCalls: Array<{
	readonly sessionId: SessionId;
	readonly queueId?: string;
	readonly input: ComposerInput;
	readonly ready?: boolean;
}> = [];
let dispatchedCommandIds: string[] = [];
let rpcClientFactory: () => Awaited<
	ReturnType<typeof import("../../src/lib/rpc-client.ts").getRpcClient>
>;

const makeQueueClient = () =>
	({
		"messages.interrupt": () =>
			Effect.sync(() => {
				interruptCalls += 1;
			}),
		"messages.queue.sendNow": (payload: {
			readonly sessionId: SessionId;
			readonly queueId: string;
		}) =>
			Effect.sync(() => {
				sendNowCalls.push(payload);
			}),
		"messages.queue.resume": (payload: { readonly sessionId: SessionId }) =>
			Effect.sync(() => {
				resumeCalls.push(payload);
			}),
		"messages.queue.flush": (payload: { readonly sessionId: SessionId }) =>
			Effect.sync(() => {
				flushCalls.push(payload);
			}),
		"messages.queue.add": (payload: {
			readonly sessionId: SessionId;
			readonly queueId?: string;
			readonly input: ComposerInput;
			readonly ready?: boolean;
		}) =>
			Effect.sync(() => {
				addCalls.push(payload);
				return queued;
			}),
	}) as unknown as Awaited<
		ReturnType<typeof import("../../src/lib/rpc-client.ts").getRpcClient>
	>;

setMessagesRpcClientForTest(async () => rpcClientFactory());
setMessagesRpcCommandDispatcherForTest(async (commandId, operation) => {
	dispatchedCommandIds.push(commandId);
	return operation();
});

describe("messages store queue actions", () => {
	afterEach(async () => {
		await teardownLiveStreams();
	});

	beforeEach(() => {
		interruptCalls = 0;
		sendNowCalls = [];
		resumeCalls = [];
		flushCalls = [];
		addCalls = [];
		dispatchedCommandIds = [];
		reportRendererRpcStreamFailure.mockReset();
		subscribeRendererRpcConnection.mockReset();
		rpcClientFactory = makeQueueClient;
		useMessagesStore.setState({
			messagesBySession: {},
			errorBySession: {},
			runningBySession: {},
			queueBySession: { [sessionId]: [queued] },
			queuePausedBySession: {},
			goalBySession: {},
		});
	});

	it("sends an idle queued item without interrupting", async () => {
		await useMessagesStore.getState().steerFromQueue(sessionId, queued.id);

		expect(interruptCalls).toBe(0);
		expect(sendNowCalls).toEqual([{ sessionId, queueId: queued.id }]);
	});

	it("resumes a paused queue through the resume RPC", async () => {
		useMessagesStore.setState({
			queuePausedBySession: { [sessionId]: true },
		});

		await useMessagesStore.getState().resumeQueue(sessionId);

		expect(resumeCalls).toEqual([{ sessionId }]);
		expect(useMessagesStore.getState().queuePausedBySession[sessionId]).toBe(
			false,
		);
	});

	it("does not force running while auto-flushing a paused queue", async () => {
		useMessagesStore.setState({
			runningBySession: { [sessionId]: false },
			queuePausedBySession: { [sessionId]: true },
		});

		useMessagesStore.getState().flushQueue(sessionId);
		await expect.poll(() => flushCalls).toEqual([{ sessionId }]);

		expect(useMessagesStore.getState().runningBySession[sessionId]).toBe(false);
	});

	it("flushes again after a queued row is durable", async () => {
		useMessagesStore.setState({ queueBySession: { [sessionId]: [] } });

		useMessagesStore.getState().queue(sessionId, input);

		await expect.poll(() => flushCalls).toEqual([{ sessionId }]);
		expect(addCalls).toEqual([
			{ sessionId, queueId: expect.stringMatching(/^q_/), input },
		]);
		expect(useMessagesStore.getState().queueBySession[sessionId]).toEqual([
			queued,
		]);
	});

	it("persists startup work as held until its payload is finalized", async () => {
		useMessagesStore.setState({ queueBySession: { [sessionId]: [] } });
		const queueId = useMessagesStore
			.getState()
			.queue(sessionId, input, { persist: false, ready: false });

		expect(
			useMessagesStore.getState().queueBySession[sessionId]?.[0]?.ready,
		).toBe(false);
		await useMessagesStore
			.getState()
			.persistQueued(sessionId, queueId, input, { ready: false });

		expect(addCalls).toEqual([{ sessionId, queueId, input, ready: false }]);
	});

	it("serializes distinct reconnect-safe flush attempts", async () => {
		useMessagesStore.getState().flushQueue(sessionId);
		useMessagesStore.getState().flushQueue(sessionId);

		await expect.poll(() => flushCalls).toHaveLength(2);
		expect(dispatchedCommandIds).toHaveLength(2);
		expect(new Set(dispatchedCommandIds).size).toBe(2);
	});

	it("retains a healthy empty transcript subscription across remounts", async () => {
		let streamCalls = 0;
		rpcClientFactory = () =>
			({
				"session.events": () => {
					streamCalls += 1;
					return streamCalls === 1 ? Stream.never : Stream.empty;
				},
				"messages.queue.stream": () => Stream.empty,
			}) as unknown as Awaited<
				ReturnType<typeof import("../../src/lib/rpc-client.ts").getRpcClient>
			>;

		await useMessagesStore.getState().hydrate(sessionId);
		await useMessagesStore.getState().hydrate(sessionId);

		expect(streamCalls).toBe(1);
	});

	it("waits for durable session creation before opening the transcript", async () => {
		let streamCalls = 0;
		rpcClientFactory = () =>
			({
				"session.events": () => {
					streamCalls += 1;
					return Stream.never;
				},
			}) as unknown as Awaited<
				ReturnType<typeof import("../../src/lib/rpc-client.ts").getRpcClient>
			>;

		deferTimelineUntilSessionCreated(sessionId);
		await useMessagesStore.getState().hydrate(sessionId);
		expect(streamCalls).toBe(0);

		acknowledgeTimelineSessionCreated(sessionId);
		await expect.poll(() => streamCalls).toBe(1);
	});

	it("applies an externally persisted message to the active transcript", async () => {
		let publishEvent: ((event: SessionTimelineFrame) => void) | undefined;
		rpcClientFactory = () =>
			({
				"session.events": () =>
					Stream.callback<SessionTimelineFrame>((queue) =>
						Effect.sync(() => {
							publishEvent = (event) => Queue.offerUnsafe(queue, event);
						}),
					),
				"messages.queue.stream": () => Stream.empty,
			}) as unknown as Awaited<
				ReturnType<typeof import("../../src/lib/rpc-client.ts").getRpcClient>
			>;

		await useMessagesStore.getState().hydrate(sessionId);
		await expect.poll(() => publishEvent).toBeDefined();
		publishEvent?.(timelineSnapshot());
		publishEvent?.(
			externalMessageEvent(1, "message-external", "arrived without reload"),
		);

		await expect
			.poll(() => useMessagesStore.getState().messagesBySession[sessionId])
			.toEqual([
				expect.objectContaining({
					id: "message-external",
					content: {
						_tag: "assistant",
						text: "arrived without reload",
					},
				}),
			]);
	});

	it("reconnects a terminated active transcript and receives auth settlement without reload", async () => {
		let streamCalls = 0;
		let publishEvent: ((event: SessionTimelineFrame) => void) | undefined;
		rpcClientFactory = () =>
			({
				"session.events": () => {
					streamCalls += 1;
					if (streamCalls === 1) {
						return Stream.die(new Error("session event transport terminated"));
					}
					return Stream.callback<SessionTimelineFrame>((queue) =>
						Effect.sync(() => {
							publishEvent = (event) => Queue.offerUnsafe(queue, event);
						}),
					);
				},
			}) as unknown as Awaited<
				ReturnType<typeof import("../../src/lib/rpc-client.ts").getRpcClient>
			>;

		await useMessagesStore.getState().hydrate(sessionId);
		await expect.poll(() => streamCalls).toBe(2);
		await expect.poll(() => publishEvent).toBeDefined();

		const turnId = AgentTurnId.make("turn-auth");
		publishEvent?.({
			kind: "snapshot",
			sessionId,
			throughVersion: 1,
			projection: SessionTimelineProjection.make({
				messages: [],
				status: "running",
				currentTurn: { turnId, phase: "running" },
				queue: QueueState.make({ items: [], paused: false }),
				permissionMode: "default",
				runtimeMode: "approval-required",
			}),
		});
		publishEvent?.({
			kind: "event",
			eventId: "event-auth-error",
			sessionId,
			streamVersion: 2,
			event: {
				_tag: "MessagePersisted",
				message: Message.make({
					id: MessageId.make("message-auth-error"),
					sessionId,
					role: "assistant",
					content: {
						_tag: "error",
						message: "Authentication required. Sign in to Grok to continue.",
					},
					createdAt: new Date("2026-06-21T00:00:02.000Z"),
				}),
			},
		});
		publishEvent?.({
			kind: "event",
			eventId: "event-auth-settled",
			sessionId,
			streamVersion: 3,
			event: { _tag: "TurnSettled", turnId, outcome: "error" },
		});
		publishEvent?.({
			kind: "event",
			eventId: "event-auth-status",
			sessionId,
			streamVersion: 4,
			event: { _tag: "StatusSet", status: "error" },
		});

		await expect
			.poll(() => useMessagesStore.getState().messagesBySession[sessionId])
			.toEqual([
				expect.objectContaining({
					id: "message-auth-error",
					content: expect.objectContaining({ _tag: "error" }),
				}),
			]);
		await expect
			.poll(() => useMessagesStore.getState().runningBySession[sessionId])
			.toBe(false);
	});

	it("resubscribes the active transcript after its connection generation changes", async () => {
		let observeConnection: ((snapshot: ConnectionSnapshot) => void) | undefined;
		let streamCalls = 0;
		let publishEvent: ((event: SessionTimelineFrame) => void) | undefined;
		subscribeRendererRpcConnection.mockImplementation((listener) => {
			observeConnection = listener;
			listener({
				key: "renderer",
				status: "connected",
				generation: 1,
				attempt: 0,
				error: null,
			});
			return vi.fn();
		});
		rpcClientFactory = () =>
			({
				"session.events": () => {
					streamCalls += 1;
					if (streamCalls === 1) {
						return Stream.fail(new Error("active transcript stream dropped"));
					}
					return Stream.callback<SessionTimelineFrame>((queue) =>
						Effect.sync(() => {
							publishEvent = (event) => Queue.offerUnsafe(queue, event);
						}),
					);
				},
				"messages.queue.stream": () => Stream.empty,
			}) as unknown as Awaited<
				ReturnType<typeof import("../../src/lib/rpc-client.ts").getRpcClient>
			>;
		useMessagesStore.setState({
			messagesBySession: { [sessionId]: [] },
			errorBySession: {},
		});

		await useMessagesStore.getState().hydrate(sessionId);
		await expect
			.poll(() => reportRendererRpcStreamFailure.mock.calls.length)
			.toBe(1);
		expect(observeConnection).toBeDefined();
		observeConnection?.({
			key: "renderer",
			status: "connected",
			generation: 2,
			attempt: 0,
			error: null,
		});
		await expect.poll(() => streamCalls).toBe(2);
		await expect.poll(() => publishEvent).toBeDefined();

		publishEvent?.(timelineSnapshot(1));
		publishEvent?.(
			externalMessageEvent(
				2,
				"message-after-reconnect",
				"visible without reload",
			),
		);

		await expect
			.poll(() => useMessagesStore.getState().messagesBySession[sessionId])
			.toEqual([
				expect.objectContaining({
					id: "message-after-reconnect",
				}),
			]);
	});
});
