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
import { Deferred, Effect, Queue, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveSessionRuntimeState } from "../../src/lib/session-runtime-state.ts";

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
	acknowledgeTimelineRendered,
	checkTimelineLiveness,
	deferTimelineUntilSessionCreated,
	setMessagesRpcClientForTest,
	setMessagesRpcCommandDispatcherForTest,
	teardownLiveStreams,
	useMessagesStore,
} = await import("../../src/store/messages.ts");
const { resetSessionRuntimeForTest, useSessionRuntimeStore } = await import(
	"../../src/store/session-runtime.ts"
);

const sessionId = "session-queue" as SessionId;
const runtimeStateForTest = () =>
	effectiveSessionRuntimeState(
		useSessionRuntimeStore.getState().bySession[sessionId],
	);
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
let runNextCalls: Array<{
	readonly sessionId: SessionId;
	readonly queueId: string;
}> = [];
let resumeCalls: Array<{ readonly sessionId: SessionId }> = [];
let flushCalls: Array<{ readonly sessionId: SessionId }> = [];
let deleteCalls: Array<{
	readonly sessionId: SessionId;
	readonly queueId: string;
}> = [];
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
		"messages.queue.runNext": (payload: {
			readonly sessionId: SessionId;
			readonly queueId: string;
		}) =>
			Effect.sync(() => {
				runNextCalls.push(payload);
			}),
		"messages.queue.resume": (payload: { readonly sessionId: SessionId }) =>
			Effect.sync(() => {
				resumeCalls.push(payload);
			}),
		"messages.queue.flush": (payload: { readonly sessionId: SessionId }) =>
			Effect.sync(() => {
				flushCalls.push(payload);
			}),
		"messages.queue.delete": (payload: {
			readonly sessionId: SessionId;
			readonly queueId: string;
		}) =>
			Effect.sync(() => {
				deleteCalls.push(payload);
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
		runNextCalls = [];
		resumeCalls = [];
		flushCalls = [];
		deleteCalls = [];
		addCalls = [];
		dispatchedCommandIds = [];
		reportRendererRpcStreamFailure.mockReset();
		subscribeRendererRpcConnection.mockReset();
		rpcClientFactory = makeQueueClient;
		useMessagesStore.setState({
			messagesBySession: {},
			timelineVersionBySession: {},
			renderRecoveryBySession: {},
			errorBySession: {},
			queueBySession: { [sessionId]: [queued] },
			queuePausedBySession: {},
			goalBySession: {},
		});
		resetSessionRuntimeForTest();
	});

	it("delegates an idle queued item to the server-owned run-next command", async () => {
		await useMessagesStore
			.getState()
			.runQueuedMessageNext(sessionId, queued.id);

		expect(interruptCalls).toBe(0);
		expect(runNextCalls).toEqual([{ sessionId, queueId: queued.id }]);
	});

	it("delegates a running session before its active turn reaches the timeline", async () => {
		useSessionRuntimeStore.getState().beginOptimisticTurn(sessionId);

		await useMessagesStore
			.getState()
			.runQueuedMessageNext(sessionId, queued.id);

		expect(runNextCalls).toEqual([{ sessionId, queueId: queued.id }]);
	});

	it("interrupts a running session even before its active turn reaches the timeline", async () => {
		useSessionRuntimeStore.getState().beginOptimisticTurn(sessionId);

		await useMessagesStore.getState().interrupt(sessionId);

		expect(interruptCalls).toBe(1);
	});

	it("clears the running indicator when interrupt acknowledgement succeeds", async () => {
		useSessionRuntimeStore.getState().beginOptimisticTurn(sessionId);

		await useMessagesStore.getState().interrupt(sessionId);

		expect(
			effectiveSessionRuntimeState(
				useSessionRuntimeStore.getState().bySession[sessionId],
			),
		).toBe("idle");
	});

	it("projects stopping immediately and settles only after interrupt acknowledgement", async () => {
		const acknowledgement = await Effect.runPromise(Deferred.make<void>());
		rpcClientFactory = () =>
			({
				...makeQueueClient(),
				"messages.interrupt": () => Deferred.await(acknowledgement),
			}) as unknown as Awaited<
				ReturnType<typeof import("../../src/lib/rpc-client.ts").getRpcClient>
			>;
		useSessionRuntimeStore.getState().beginOptimisticTurn(sessionId);

		const interrupt = useMessagesStore.getState().interrupt(sessionId);
		expect(
			effectiveSessionRuntimeState(
				useSessionRuntimeStore.getState().bySession[sessionId],
			),
		).toBe("stopping");

		Effect.runSync(Deferred.succeed(acknowledgement, undefined));
		await interrupt;
		expect(
			effectiveSessionRuntimeState(
				useSessionRuntimeStore.getState().bySession[sessionId],
			),
		).toBe("idle");
	});

	it("restores a queued item when run-next fails", async () => {
		useSessionRuntimeStore.getState().beginOptimisticTurn(sessionId);
		rpcClientFactory = () =>
			({
				...makeQueueClient(),
				"messages.queue.runNext": () =>
					Effect.fail(new Error("run next failed")),
			}) as unknown as Awaited<
				ReturnType<typeof import("../../src/lib/rpc-client.ts").getRpcClient>
			>;

		await useMessagesStore
			.getState()
			.runQueuedMessageNext(sessionId, queued.id);

		expect(useMessagesStore.getState().queueBySession[sessionId]).toEqual([
			queued,
		]);
		expect(useMessagesStore.getState().errorBySession[sessionId]).toEqual({
			kind: "generic",
			message: "Couldn’t run that message next. It is still in your queue.",
		});
	});

	it("removes and returns a queued item for editing in the regular composer", async () => {
		const taken = await useMessagesStore
			.getState()
			.takeQueuedForEdit(sessionId, queued.id);

		expect(taken).toEqual(queued);
		expect(deleteCalls).toEqual([{ sessionId, queueId: queued.id }]);
		expect(useMessagesStore.getState().queueBySession[sessionId]).toEqual([]);
	});

	it("restores a queued item when opening it for editing fails", async () => {
		rpcClientFactory = () =>
			({
				...makeQueueClient(),
				"messages.queue.delete": () => Effect.fail(new Error("delete failed")),
			}) as unknown as Awaited<
				ReturnType<typeof import("../../src/lib/rpc-client.ts").getRpcClient>
			>;

		const taken = await useMessagesStore
			.getState()
			.takeQueuedForEdit(sessionId, queued.id);

		expect(taken).toBeNull();
		expect(useMessagesStore.getState().queueBySession[sessionId]).toEqual([
			queued,
		]);
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
			queuePausedBySession: { [sessionId]: true },
		});

		useMessagesStore.getState().flushQueue(sessionId);
		await expect.poll(() => flushCalls).toEqual([{ sessionId }]);

		expect(
			useSessionRuntimeStore.getState().bySession[sessionId],
		).toBeUndefined();
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
			.poll(() =>
				effectiveSessionRuntimeState(
					useSessionRuntimeStore.getState().bySession[sessionId],
				),
			)
			.toBe("failed");
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

	it("releases an optimistic overlay when its timeline stream terminates", async () => {
		const frames = Effect.runSync(
			Queue.unbounded<SessionTimelineFrame, Error>(),
		);
		rpcClientFactory = () =>
			({
				"session.events": () => Stream.fromQueue(frames),
				"messages.queue.stream": () => Stream.empty,
			}) as unknown as Awaited<
				ReturnType<typeof import("../../src/lib/rpc-client.ts").getRpcClient>
			>;

		await useMessagesStore.getState().hydrate(sessionId);
		Queue.offerUnsafe(frames, {
			kind: "snapshot",
			sessionId,
			throughVersion: 1,
			projection: SessionTimelineProjection.make({
				messages: [],
				status: "idle",
				currentTurn: null,
				queue: QueueState.make({ items: [], paused: false }),
				permissionMode: "default",
				runtimeMode: "approval-required",
			}),
		});
		await expect.poll(runtimeStateForTest).toBe("idle");

		useSessionRuntimeStore.getState().beginOptimisticTurn(sessionId);
		expect(runtimeStateForTest()).toBe("starting");
		await Effect.runPromise(Queue.shutdown(frames));

		await expect.poll(runtimeStateForTest).toBe("idle");
	});

	it("opens a retained transcript when the first connection becomes available", async () => {
		let observeConnection: ((snapshot: ConnectionSnapshot) => void) | undefined;
		let acquisitionCalls = 0;
		let streamCalls = 0;
		subscribeRendererRpcConnection.mockImplementation((listener) => {
			observeConnection = listener;
			listener({
				key: "renderer",
				status: "connecting",
				generation: 0,
				attempt: 1,
				error: null,
			});
			return vi.fn();
		});
		rpcClientFactory = () => {
			acquisitionCalls += 1;
			if (acquisitionCalls === 1) {
				throw new Error("connection unavailable");
			}
			return {
				"session.events": () => {
					streamCalls += 1;
					return Stream.never;
				},
			} as unknown as Awaited<
				ReturnType<typeof import("../../src/lib/rpc-client.ts").getRpcClient>
			>;
		};

		await useMessagesStore.getState().hydrate(sessionId);
		expect(acquisitionCalls).toBe(1);
		expect(streamCalls).toBe(0);

		observeConnection?.({
			key: "renderer",
			status: "connected",
			generation: 1,
			attempt: 0,
			error: null,
		});

		await expect.poll(() => streamCalls).toBe(1);
	});

	it("opens only one transcript when connection observation is synchronously connected", async () => {
		let streamCalls = 0;
		subscribeRendererRpcConnection.mockImplementation((listener) => {
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
					return Stream.never;
				},
			}) as unknown as Awaited<
				ReturnType<typeof import("../../src/lib/rpc-client.ts").getRpcClient>
			>;

		await useMessagesStore.getState().hydrate(sessionId);

		await expect.poll(() => streamCalls).toBe(1);
	});

	it("replaces an open stream when the durable cursor advances without frames", async () => {
		let streamCalls = 0;
		let observedAfterVersion: number | undefined;
		let publishEvent: ((event: SessionTimelineFrame) => void) | undefined;
		rpcClientFactory = () =>
			({
				"session.events": (input: { afterVersion?: number }) => {
					streamCalls += 1;
					observedAfterVersion = input.afterVersion;
					return Stream.callback<SessionTimelineFrame>((queue) =>
						Effect.sync(() => {
							publishEvent = (event) => Queue.offerUnsafe(queue, event);
						}),
					);
				},
				"session.events.head": () => Effect.succeed({ throughVersion: 3 }),
			}) as unknown as Awaited<
				ReturnType<typeof import("../../src/lib/rpc-client.ts").getRpcClient>
			>;

		await useMessagesStore.getState().hydrate(sessionId);
		await expect.poll(() => publishEvent).toBeDefined();
		publishEvent?.(timelineSnapshot(1));
		publishEvent?.(externalMessageEvent(2, "message-before-stall", "visible"));
		publishEvent?.({
			kind: "synchronized",
			sessionId,
			throughVersion: 2,
		});
		await expect
			.poll(() => useMessagesStore.getState().messagesBySession[sessionId])
			.toEqual([expect.objectContaining({ id: "message-before-stall" })]);

		await expect(checkTimelineLiveness(sessionId)).resolves.toBe(false);
		await expect(checkTimelineLiveness(sessionId)).resolves.toBe(true);

		await expect.poll(() => streamCalls).toBe(2);
		expect(observedAfterVersion).toBe(2);
	});

	it("remounts the virtualized timeline when rendering falls behind applied state", async () => {
		let publishEvent: ((event: SessionTimelineFrame) => void) | undefined;
		rpcClientFactory = () =>
			({
				"session.events": () =>
					Stream.callback<SessionTimelineFrame>((queue) =>
						Effect.sync(() => {
							publishEvent = (event) => Queue.offerUnsafe(queue, event);
						}),
					),
				"session.events.head": () => Effect.succeed({ throughVersion: 2 }),
			}) as unknown as Awaited<
				ReturnType<typeof import("../../src/lib/rpc-client.ts").getRpcClient>
			>;

		await useMessagesStore.getState().hydrate(sessionId);
		await expect.poll(() => publishEvent).toBeDefined();
		publishEvent?.(timelineSnapshot(1));
		publishEvent?.(externalMessageEvent(2, "message-render-stall", "visible"));
		publishEvent?.({
			kind: "synchronized",
			sessionId,
			throughVersion: 2,
		});
		await expect
			.poll(
				() => useMessagesStore.getState().timelineVersionBySession[sessionId],
			)
			.toBe(2);
		acknowledgeTimelineRendered(sessionId, 1);

		await expect(checkTimelineLiveness(sessionId)).resolves.toBe(true);

		expect(useMessagesStore.getState().renderRecoveryBySession[sessionId]).toBe(
			1,
		);
	});
});
