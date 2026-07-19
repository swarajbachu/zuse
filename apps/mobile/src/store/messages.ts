import {
	projectSessionEvent,
	sessionEventCursors,
} from "@zuse/client-runtime/session-events";
import type {
	ComposerInput,
	Message,
	MessageId,
	QueuedMessage,
	SessionId,
} from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";
import { AppState } from "react-native";
import { create } from "zustand";
import { connectionSessionKey } from "~/lib/session-key";
import { readMessagesSnapshot, writeMessagesSnapshot } from "~/offline/cache";
import { getConnectionClient, reportConnectionFailure } from "~/rpc/connection";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

type MessagesState = {
	messagesBySession: Record<string, readonly Message[]>;
	queueBySession: Record<string, readonly QueuedMessage[]>;
	queuePausedBySession: Record<string, boolean>;
	reconnectingBySession: Record<string, boolean>;
	errorBySession: Record<string, string | null>;
	hydrate: (
		connKey: string,
		options: WsProtocolOptions,
		sessionId: SessionId,
	) => Promise<void>;
	flush: (connKey: string, sessionId: SessionId) => Promise<void>;
	deleteQueued: (
		connKey: string,
		options: WsProtocolOptions,
		sessionId: SessionId,
		queueId: string,
	) => Promise<void>;
	updateQueued: (
		connKey: string,
		options: WsProtocolOptions,
		sessionId: SessionId,
		queueId: string,
		input: ComposerInput,
	) => Promise<void>;
	reorderQueued: (
		connKey: string,
		options: WsProtocolOptions,
		sessionId: SessionId,
		queueIds: readonly string[],
	) => Promise<void>;
	sendQueuedNow: (
		connKey: string,
		options: WsProtocolOptions,
		sessionId: SessionId,
		queueId: string,
	) => Promise<void>;
	resumeQueue: (
		connKey: string,
		options: WsProtocolOptions,
		sessionId: SessionId,
	) => Promise<void>;
};

const liveFibers = new Map<string, Fiber.Fiber<unknown, unknown>>();
const queueFibers = new Map<string, Fiber.Fiber<unknown, unknown>>();
const eventCursorKey = (liveKey: string): string =>
	`mobile:messages:${liveKey}`;
const optimisticIds = new Set<MessageId>();
let appStateInstalled = false;

const stopFiber = async (
	key: string,
	fibers: Map<string, Fiber.Fiber<unknown, unknown>>,
) => {
	const fiber = fibers.get(key);
	if (fiber !== undefined) {
		fibers.delete(key);
		await Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {});
	}
};

const stop = async (key: string) => {
	await Promise.all([stopFiber(key, liveFibers), stopFiber(key, queueFibers)]);
};

export const resetMessagesRuntime = async (): Promise<void> => {
	const keys = new Set([...liveFibers.keys(), ...queueFibers.keys()]);
	await Promise.all(Array.from(keys, stop));
	optimisticIds.clear();
	sessionEventCursors.clearPrefix("mobile:messages:");
	useMobileMessagesStore.setState({
		messagesBySession: {},
		queueBySession: {},
		queuePausedBySession: {},
		reconnectingBySession: {},
		errorBySession: {},
	});
};

export const useMobileMessagesStore = create<MessagesState>((set, get) => ({
	messagesBySession: {},
	queueBySession: {},
	queuePausedBySession: {},
	reconnectingBySession: {},
	errorBySession: {},
	hydrate: async (connKey, options, sessionId) => {
		installAppStateFlush(get);
		const liveKey = connectionSessionKey(connKey, sessionId);
		await stop(liveKey);

		const cached = await Effect.runPromise(
			readMessagesSnapshot(connKey, sessionId),
		);
		if (cached !== null) {
			sessionEventCursors.set(eventCursorKey(liveKey), cached.highestSequence);
			set((state) => ({
				messagesBySession: {
					...state.messagesBySession,
					[liveKey]: cached.messages,
				},
			}));
		}

		set((state) => ({
			reconnectingBySession: {
				...state.reconnectingBySession,
				[liveKey]: false,
			},
			errorBySession: { ...state.errorBySession, [liveKey]: null },
		}));

		const run = async () => {
			try {
				const client = await Effect.runPromise(getConnectionClient(options));
				const listed = await Effect.runPromise(
					client["messages.list"]({ sessionId }),
				);
				const listedQueue = await Effect.runPromise(
					client["messages.queue.list"]({ sessionId }),
				);
				set((state) => ({
					queueBySession: {
						...state.queueBySession,
						[liveKey]: listedQueue.items,
					},
					queuePausedBySession: {
						...state.queuePausedBySession,
						[liveKey]: listedQueue.paused,
					},
				}));
				if (listed.length > 0) {
					set((state) => ({
						messagesBySession: {
							...state.messagesBySession,
							[liveKey]: listed,
						},
					}));
					void get().flush(connKey, sessionId);
				}
				console.info("[mobile] session.events", { sessionId });
				const afterSequence =
					sessionEventCursors.get(eventCursorKey(liveKey)) ?? 0;
				const program = Stream.runForEach(
					client["session.events"]({ sessionId, afterSequence }),
					(envelope) =>
						Effect.sync(() => {
							sessionEventCursors.set(
								eventCursorKey(liveKey),
								envelope.sequence,
							);
							console.info("[mobile] session.events envelope", {
								sessionId,
								sequence: envelope.sequence,
							});
							const projected = projectSessionEvent(envelope);
							if (projected._tag !== "message") return;
							const { message } = projected;
							set((state) => {
								const current = state.messagesBySession[liveKey] ?? [];
								if (optimisticIds.has(message.id)) {
									optimisticIds.delete(message.id);
									return {
										messagesBySession: {
											...state.messagesBySession,
											[liveKey]: current.map((currentMessage) =>
												currentMessage.id === message.id
													? message
													: currentMessage,
											),
										},
									};
								}
								const existingIndex = current.findIndex(
									(currentMessage) => currentMessage.id === message.id,
								);
								if (existingIndex !== -1) {
									return {
										messagesBySession: {
											...state.messagesBySession,
											[liveKey]: current.map((currentMessage, index) =>
												index === existingIndex ? message : currentMessage,
											),
										},
									};
								}
								const next = [...current, message].slice(-500);
								return {
									messagesBySession: {
										...state.messagesBySession,
										[liveKey]: next,
									},
								};
							});
							void get().flush(connKey, sessionId);
						}),
				).pipe(
					Effect.catch((cause) =>
						Effect.sync(() => {
							set((state) => ({
								reconnectingBySession: {
									...state.reconnectingBySession,
									[liveKey]: true,
								},
								errorBySession: {
									...state.errorBySession,
									[liveKey]:
										cause instanceof Error ? cause.message : String(cause),
								},
							}));
						}),
					),
				);
				liveFibers.set(liveKey, Effect.runFork(program));
				const queueProgram = Stream.runForEach(
					client["messages.queue.stream"]({ sessionId }),
					(queue) =>
						Effect.sync(() => {
							set((state) => ({
								queueBySession: {
									...state.queueBySession,
									[liveKey]: queue.items,
								},
								queuePausedBySession: {
									...state.queuePausedBySession,
									[liveKey]: queue.paused,
								},
							}));
						}),
				).pipe(
					Effect.catch((cause) =>
						Effect.sync(() => {
							console.warn("[mobile] queue stream errored", {
								sessionId,
								reason: cause instanceof Error ? cause.message : String(cause),
							});
						}),
					),
				);
				queueFibers.set(liveKey, Effect.runFork(queueProgram));
			} catch (cause) {
				reportConnectionFailure(options, cause);
				set((state) => ({
					reconnectingBySession: {
						...state.reconnectingBySession,
						[liveKey]: true,
					},
					errorBySession: {
						...state.errorBySession,
						[liveKey]: cause instanceof Error ? cause.message : String(cause),
					},
				}));
			}
		};

		await run();
	},
	flush: async (connKey, sessionId) => {
		const liveKey = connectionSessionKey(connKey, sessionId);
		const messages = get().messagesBySession[liveKey] ?? [];
		await Effect.runPromise(
			writeMessagesSnapshot(connKey, sessionId, {
				highestSequence: sessionEventCursors.get(eventCursorKey(liveKey)) ?? 0,
				messages,
			}),
		).catch(() => {});
	},
	deleteQueued: async (connKey, options, sessionId, queueId) => {
		const liveKey = connectionSessionKey(connKey, sessionId);
		const previous = get().queueBySession[liveKey] ?? [];
		set((state) => ({
			queueBySession: {
				...state.queueBySession,
				[liveKey]: previous.filter((item) => item.id !== queueId),
			},
		}));
		try {
			const client = await Effect.runPromise(getConnectionClient(options));
			await Effect.runPromise(
				client["messages.queue.delete"]({ sessionId, queueId }),
			);
		} catch (cause) {
			reportConnectionFailure(options, cause);
			set((state) => ({
				queueBySession: { ...state.queueBySession, [liveKey]: previous },
			}));
		}
	},
	updateQueued: async (connKey, options, sessionId, queueId, input) => {
		const key = connectionSessionKey(connKey, sessionId);
		const previous = get().queueBySession[key] ?? [];
		try {
			const client = await Effect.runPromise(getConnectionClient(options));
			const updated = await Effect.runPromise(
				client["messages.queue.update"]({ sessionId, queueId, input }),
			);
			set((state) => ({
				queueBySession: {
					...state.queueBySession,
					[key]: (state.queueBySession[key] ?? []).map((item) =>
						item.id === queueId ? updated : item,
					),
				},
			}));
		} catch (cause) {
			reportConnectionFailure(options, cause);
			set((state) => ({
				queueBySession: { ...state.queueBySession, [key]: previous },
				errorBySession: { ...state.errorBySession, [key]: messageOf(cause) },
			}));
			throw cause;
		}
	},
	reorderQueued: async (connKey, options, sessionId, queueIds) => {
		const key = connectionSessionKey(connKey, sessionId);
		const previous = get().queueBySession[key] ?? [];
		const byId = new Map(previous.map((item) => [item.id, item]));
		const optimistic = queueIds.flatMap((id) => byId.get(id) ?? []);
		set((state) => ({
			queueBySession: { ...state.queueBySession, [key]: optimistic },
		}));
		try {
			const client = await Effect.runPromise(getConnectionClient(options));
			const next = await Effect.runPromise(
				client["messages.queue.reorder"]({
					sessionId,
					queueIds: [...queueIds],
				}),
			);
			set((state) => ({
				queueBySession: { ...state.queueBySession, [key]: next },
			}));
		} catch (cause) {
			reportConnectionFailure(options, cause);
			set((state) => ({
				queueBySession: { ...state.queueBySession, [key]: previous },
			}));
			throw cause;
		}
	},
	sendQueuedNow: async (connKey, options, sessionId, queueId) => {
		const key = connectionSessionKey(connKey, sessionId);
		const previous = get().queueBySession[key] ?? [];
		set((state) => ({
			queueBySession: {
				...state.queueBySession,
				[key]: previous.filter((item) => item.id !== queueId),
			},
		}));
		try {
			const client = await Effect.runPromise(getConnectionClient(options));
			await Effect.runPromise(
				client["messages.queue.sendNow"]({ sessionId, queueId }),
			);
		} catch (cause) {
			reportConnectionFailure(options, cause);
			set((state) => ({
				queueBySession: { ...state.queueBySession, [key]: previous },
			}));
			throw cause;
		}
	},
	resumeQueue: async (connKey, options, sessionId) => {
		const key = connectionSessionKey(connKey, sessionId);
		set((state) => ({
			queuePausedBySession: { ...state.queuePausedBySession, [key]: false },
		}));
		try {
			const client = await Effect.runPromise(getConnectionClient(options));
			await Effect.runPromise(client["messages.queue.resume"]({ sessionId }));
		} catch (cause) {
			reportConnectionFailure(options, cause);
			set((state) => ({
				queuePausedBySession: { ...state.queuePausedBySession, [key]: true },
			}));
			throw cause;
		}
	},
}));

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

export const addOptimisticMessage = (key: string, message: Message): void => {
	optimisticIds.add(message.id);
	useMobileMessagesStore.setState((state) => ({
		messagesBySession: {
			...state.messagesBySession,
			[key]: [...(state.messagesBySession[key] ?? []), message].slice(-500),
		},
	}));
};

export const removeOptimisticMessage = (
	key: string,
	messageId: MessageId,
): void => {
	optimisticIds.delete(messageId);
	useMobileMessagesStore.setState((state) => ({
		messagesBySession: {
			...state.messagesBySession,
			[key]: (state.messagesBySession[key] ?? []).filter(
				(message) => message.id !== messageId,
			),
		},
	}));
};

const installAppStateFlush = (get: () => MessagesState) => {
	if (appStateInstalled) return;
	appStateInstalled = true;
	AppState.addEventListener("change", (next) => {
		if (next !== "background") return;
		for (const key of liveFibers.keys()) {
			const [connKey, sessionId] = parseLiveKey(key);
			if (connKey !== undefined && sessionId !== undefined) {
				void get().flush(connKey, sessionId as SessionId);
			}
			void stop(key);
		}
	});
};

const parseLiveKey = (
	key: string,
): [string | undefined, string | undefined] => {
	try {
		return JSON.parse(key) as [string, string];
	} catch {
		return [undefined, undefined];
	}
};
