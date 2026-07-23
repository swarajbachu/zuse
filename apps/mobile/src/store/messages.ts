import { SessionTimelineRegistry } from "@zuse/client-runtime/session-timeline";
import {
	type ComposerInput,
	type Message,
	type MessageId,
	type QueuedMessage,
	SessionId,
} from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { AppState } from "react-native";

import { connectionSessionKey } from "~/lib/session-key";
import { readMessagesSnapshot, writeMessagesSnapshot } from "~/offline/cache";
import { getConnectionClient, reportConnectionFailure } from "~/rpc/connection";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

import { appAtomRegistry, batchAtomUpdates } from "./registry";
import {
	resetSessionTurnActivity,
	syncSessionTurnActivity,
} from "./session-turn-activity";

export const messagesBySessionAtom = Atom.make<
	Record<string, readonly Message[]>
>({}).pipe(Atom.keepAlive);
export const queueBySessionAtom = Atom.make<
	Record<string, readonly QueuedMessage[]>
>({}).pipe(Atom.keepAlive);
export const queuePausedBySessionAtom = Atom.make<Record<string, boolean>>(
	{},
).pipe(Atom.keepAlive);
export const reconnectingBySessionAtom = Atom.make<Record<string, boolean>>(
	{},
).pipe(Atom.keepAlive);
export const messagesErrorBySessionAtom = Atom.make<
	Record<string, string | null>
>({}).pipe(Atom.keepAlive);

const EMPTY_MESSAGES: readonly Message[] = [];
const EMPTY_QUEUE: readonly QueuedMessage[] = [];

/** Per-session transcript; notifies only when this session's messages change. */
export const sessionMessagesAtom = Atom.family((key: string) =>
	Atom.make((get) => get(messagesBySessionAtom)[key] ?? EMPTY_MESSAGES),
);
/** Per-session server queue; notifies only for this session. */
export const sessionQueueAtom = Atom.family((key: string) =>
	Atom.make((get) => get(queueBySessionAtom)[key] ?? EMPTY_QUEUE),
);
export const sessionQueuePausedAtom = Atom.family((key: string) =>
	Atom.make((get) => get(queuePausedBySessionAtom)[key] === true),
);
export const sessionMessagesErrorAtom = Atom.family((key: string) =>
	Atom.make((get) => get(messagesErrorBySessionAtom)[key] ?? null),
);

const liveFibers = new Map<string, Fiber.Fiber<unknown, unknown>>();
const timelineRegistry = new SessionTimelineRegistry();
const retainedTimelines = new Set<string>();
const evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const currentSessionTurnId = (connKey: string, sessionId: SessionId) =>
	timelineRegistry.state(
		SessionId.make(connectionSessionKey(connKey, sessionId)),
	).projection?.currentTurn?.turnId;
const optimisticIds = new Set<MessageId>();
const hydrationGeneration = new Map<string, number>();
let appStateInstalled = false;

const patchMessages = (key: string, messages: readonly Message[]): void => {
	appAtomRegistry.update(messagesBySessionAtom, (state) => ({
		...state,
		[key]: messages,
	}));
};

const patchQueue = (key: string, items: readonly QueuedMessage[]): void => {
	appAtomRegistry.update(queueBySessionAtom, (state) => ({
		...state,
		[key]: items,
	}));
};

const patchQueuePaused = (key: string, paused: boolean): void => {
	appAtomRegistry.update(queuePausedBySessionAtom, (state) => ({
		...state,
		[key]: paused,
	}));
};

const patchReconnecting = (key: string, reconnecting: boolean): void => {
	appAtomRegistry.update(reconnectingBySessionAtom, (state) => ({
		...state,
		[key]: reconnecting,
	}));
};

const patchError = (key: string, error: string | null): void => {
	appAtomRegistry.update(messagesErrorBySessionAtom, (state) => ({
		...state,
		[key]: error,
	}));
};

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
	await stopFiber(key, liveFibers);
};

export const resetMessagesRuntime = async (): Promise<void> => {
	const keys = new Set(liveFibers.keys());
	await Promise.all(Array.from(keys, stop));
	optimisticIds.clear();
	hydrationGeneration.clear();
	for (const timer of evictionTimers.values()) clearTimeout(timer);
	evictionTimers.clear();
	retainedTimelines.clear();
	timelineRegistry.shutdown();
	resetSessionTurnActivity();
	batchAtomUpdates(() => {
		appAtomRegistry.set(messagesBySessionAtom, {});
		appAtomRegistry.set(queueBySessionAtom, {});
		appAtomRegistry.set(queuePausedBySessionAtom, {});
		appAtomRegistry.set(reconnectingBySessionAtom, {});
		appAtomRegistry.set(messagesErrorBySessionAtom, {});
	});
};

/**
 * Releases a screen's interest in a session timeline. The live stream and
 * projection stay warm for five minutes (and for as long as a turn is still
 * running) so returning to the thread resumes instantly instead of replaying.
 */
export const releaseMessages = async (
	connKey: string,
	sessionId: SessionId,
): Promise<void> => {
	const key = connectionSessionKey(connKey, sessionId);
	retainedTimelines.delete(key);
	if (
		timelineRegistry.state(SessionId.make(key)).projection?.currentTurn != null
	) {
		return;
	}
	const previous = evictionTimers.get(key);
	if (previous !== undefined) clearTimeout(previous);
	evictionTimers.set(
		key,
		setTimeout(() => {
			evictionTimers.delete(key);
			if (retainedTimelines.has(key)) return;
			void stop(key);
			timelineRegistry.delete(SessionId.make(key));
		}, 5 * 60_000),
	);
};

export const hydrateMessages = async (
	connKey: string,
	options: WsProtocolOptions,
	sessionId: SessionId,
): Promise<void> => {
	installAppStateFlush();
	const liveKey = connectionSessionKey(connKey, sessionId);
	retainedTimelines.add(liveKey);
	const eviction = evictionTimers.get(liveKey);
	if (eviction !== undefined) clearTimeout(eviction);
	evictionTimers.delete(liveKey);
	if (liveFibers.has(liveKey)) return;
	const generation = (hydrationGeneration.get(liveKey) ?? 0) + 1;
	hydrationGeneration.set(liveKey, generation);

	const cached = await Effect.runPromise(
		readMessagesSnapshot(connKey, sessionId),
	);
	if (hydrationGeneration.get(liveKey) !== generation) return;
	if (cached !== null) {
		patchMessages(liveKey, cached.messages);
	}

	batchAtomUpdates(() => {
		patchReconnecting(liveKey, false);
		patchError(liveKey, null);
	});

	const run = async () => {
		try {
			const client = await Effect.runPromise(getConnectionClient(options));
			const listed = await Effect.runPromise(
				client["messages.list"]({ sessionId }),
			);
			if (hydrationGeneration.get(liveKey) !== generation) return;
			if (listed.length > 0) {
				patchMessages(liveKey, listed);
				void flushMessages(connKey, sessionId);
			}
			console.info("[mobile] session.events", { sessionId });
			const retained = timelineRegistry.state(SessionId.make(liveKey));
			const program = Stream.runForEach(
				client["session.events"]({
					sessionId,
					afterVersion: retained.appliedVersion,
					hasProjection: retained.projection !== null,
				}),
				(frame) =>
					Effect.sync(() => {
						if (hydrationGeneration.get(liveKey) !== generation) return;
						timelineRegistry.accept(SessionId.make(liveKey), frame);
						const next = timelineRegistry.state(SessionId.make(liveKey));
						console.info("[mobile] session.events envelope", {
							sessionId,
							version:
								frame.kind === "event"
									? frame.streamVersion
									: frame.throughVersion,
						});
						if (next.projection === null) return;
						const durable = next.projection.messages;
						const durableIds = new Set(durable.map((message) => message.id));
						for (const id of optimisticIds) {
							if (durableIds.has(id)) optimisticIds.delete(id);
						}
						batchAtomUpdates(() => {
							syncSessionTurnActivity(
								liveKey,
								next.projection?.currentTurn != null,
							);
							appAtomRegistry.update(messagesBySessionAtom, (state) => {
								const current = state[liveKey] ?? [];
								const pending = current.filter(
									(message) =>
										optimisticIds.has(message.id) &&
										!durableIds.has(message.id),
								);
								return {
									...state,
									[liveKey]: [...durable, ...pending].slice(-500),
								};
							});
							patchQueue(liveKey, next.projection?.queue.items ?? []);
							patchQueuePaused(liveKey, next.projection?.queue.paused ?? false);
						});
						void flushMessages(connKey, sessionId);
					}),
			).pipe(
				Effect.catch((cause) =>
					Effect.sync(() => {
						if (hydrationGeneration.get(liveKey) !== generation) return;
						batchAtomUpdates(() => {
							patchReconnecting(liveKey, true);
							patchError(liveKey, messageOf(cause));
						});
					}),
				),
			);
			liveFibers.set(liveKey, Effect.runFork(program));
		} catch (cause) {
			if (hydrationGeneration.get(liveKey) !== generation) return;
			reportConnectionFailure(options, cause);
			batchAtomUpdates(() => {
				patchReconnecting(liveKey, true);
				patchError(liveKey, messageOf(cause));
			});
		}
	};

	await run();
};

export const flushMessages = async (
	connKey: string,
	sessionId: SessionId,
): Promise<void> => {
	const liveKey = connectionSessionKey(connKey, sessionId);
	const messages = appAtomRegistry.get(messagesBySessionAtom)[liveKey] ?? [];
	await Effect.runPromise(
		writeMessagesSnapshot(connKey, sessionId, {
			highestSequence: timelineRegistry.state(SessionId.make(liveKey))
				.appliedVersion,
			messages,
		}),
	).catch(() => {});
};

export const deleteQueuedMessage = async (
	connKey: string,
	options: WsProtocolOptions,
	sessionId: SessionId,
	queueId: string,
): Promise<void> => {
	const liveKey = connectionSessionKey(connKey, sessionId);
	const previous = appAtomRegistry.get(queueBySessionAtom)[liveKey] ?? [];
	patchQueue(
		liveKey,
		previous.filter((item) => item.id !== queueId),
	);
	try {
		const client = await Effect.runPromise(getConnectionClient(options));
		await Effect.runPromise(
			client["messages.queue.delete"]({ sessionId, queueId }),
		);
	} catch (cause) {
		reportConnectionFailure(options, cause);
		patchQueue(liveKey, previous);
	}
};

export const updateQueuedMessage = async (
	connKey: string,
	options: WsProtocolOptions,
	sessionId: SessionId,
	queueId: string,
	input: ComposerInput,
): Promise<void> => {
	const key = connectionSessionKey(connKey, sessionId);
	const previous = appAtomRegistry.get(queueBySessionAtom)[key] ?? [];
	try {
		const client = await Effect.runPromise(getConnectionClient(options));
		const updated = await Effect.runPromise(
			client["messages.queue.update"]({ sessionId, queueId, input }),
		);
		appAtomRegistry.update(queueBySessionAtom, (state) => ({
			...state,
			[key]: (state[key] ?? []).map((item) =>
				item.id === queueId ? updated : item,
			),
		}));
	} catch (cause) {
		reportConnectionFailure(options, cause);
		batchAtomUpdates(() => {
			patchQueue(key, previous);
			patchError(key, messageOf(cause));
		});
		throw cause;
	}
};

export const reorderQueuedMessages = async (
	connKey: string,
	options: WsProtocolOptions,
	sessionId: SessionId,
	queueIds: readonly string[],
): Promise<void> => {
	const key = connectionSessionKey(connKey, sessionId);
	const previous = appAtomRegistry.get(queueBySessionAtom)[key] ?? [];
	const byId = new Map(previous.map((item) => [item.id, item]));
	const optimistic = queueIds.flatMap((id) => byId.get(id) ?? []);
	patchQueue(key, optimistic);
	try {
		const client = await Effect.runPromise(getConnectionClient(options));
		const next = await Effect.runPromise(
			client["messages.queue.reorder"]({
				sessionId,
				queueIds: [...queueIds],
			}),
		);
		patchQueue(key, next);
	} catch (cause) {
		reportConnectionFailure(options, cause);
		patchQueue(key, previous);
		throw cause;
	}
};

export const sendQueuedMessageNow = async (
	connKey: string,
	options: WsProtocolOptions,
	sessionId: SessionId,
	queueId: string,
): Promise<void> => {
	const key = connectionSessionKey(connKey, sessionId);
	const previous = appAtomRegistry.get(queueBySessionAtom)[key] ?? [];
	patchQueue(
		key,
		previous.filter((item) => item.id !== queueId),
	);
	try {
		const client = await Effect.runPromise(getConnectionClient(options));
		await Effect.runPromise(
			client["messages.queue.sendNow"]({ sessionId, queueId }),
		);
	} catch (cause) {
		reportConnectionFailure(options, cause);
		patchQueue(key, previous);
		throw cause;
	}
};

export const resumeQueue = async (
	connKey: string,
	options: WsProtocolOptions,
	sessionId: SessionId,
): Promise<void> => {
	const key = connectionSessionKey(connKey, sessionId);
	patchQueuePaused(key, false);
	try {
		const client = await Effect.runPromise(getConnectionClient(options));
		await Effect.runPromise(client["messages.queue.resume"]({ sessionId }));
	} catch (cause) {
		reportConnectionFailure(options, cause);
		patchQueuePaused(key, true);
		throw cause;
	}
};

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

export const addOptimisticMessage = (key: string, message: Message): void => {
	optimisticIds.add(message.id);
	appAtomRegistry.update(messagesBySessionAtom, (state) => ({
		...state,
		[key]: [...(state[key] ?? []), message].slice(-500),
	}));
};

export const removeOptimisticMessage = (
	key: string,
	messageId: MessageId,
): void => {
	optimisticIds.delete(messageId);
	appAtomRegistry.update(messagesBySessionAtom, (state) => ({
		...state,
		[key]: (state[key] ?? []).filter((message) => message.id !== messageId),
	}));
};

const installAppStateFlush = () => {
	if (appStateInstalled) return;
	appStateInstalled = true;
	AppState.addEventListener("change", (next) => {
		if (next !== "background") return;
		for (const key of liveFibers.keys()) {
			const [connKey, sessionId] = parseLiveKey(key);
			if (connKey !== undefined && sessionId !== undefined) {
				void flushMessages(connKey, sessionId as SessionId);
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
