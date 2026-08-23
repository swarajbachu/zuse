import type {
	ComposerInput,
	EnvironmentId,
	Message,
	MessageId,
	QueuedMessage,
	SessionId,
} from "@zuse/contracts";
import { Atom } from "effect/unstable/reactivity";

import { connectionErrorMessage } from "~/lib/connection-error-message";
import { connectionSessionKey } from "~/lib/session-key";
import { reportConnectionFailure } from "~/rpc/connection";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

import {
	dispatchMobileSessionCommandResult,
	mobileClientBus,
	registerMobileEnvironment,
	resetMobileClientBus,
	sessionTimelineKey,
} from "./mobile-client-bus";
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

type RetainedTimeline = Readonly<{
	environmentId: EnvironmentId;
	key: ReturnType<typeof sessionTimelineKey>;
	lease: ReturnType<ReturnType<typeof mobileClientBus>["retain"]>;
	unsubscribe: () => void;
}>;

const retainedTimelines = new Map<string, RetainedTimeline>();
export const currentSessionTurnId = (connKey: string, sessionId: SessionId) =>
	(() => {
		const retained = retainedTimelines.get(
			connectionSessionKey(connKey, sessionId),
		);
		return retained === undefined
			? undefined
			: mobileClientBus().snapshot(retained.key).data?.currentTurn?.turnId;
	})();
const optimisticIds = new Set<MessageId>();
const dispatchSessionCommand = async <Result>(
	connKey: string,
	options: WsProtocolOptions,
	sessionId: SessionId,
	kind: string,
	payload: unknown,
): Promise<Result> => {
	return dispatchMobileSessionCommandResult<Result>({
		connKey,
		connection: options,
		sessionId,
		kind,
		payload,
	});
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

const publishTimeline = (liveKey: string, retained: RetainedTimeline): void => {
	const view = mobileClientBus().snapshot(retained.key);
	const projection = view.data;
	if (projection !== null && projection !== undefined) {
		const durable = projection.messages;
		const durableIds = new Set(durable.map((message) => message.id));
		for (const id of optimisticIds) {
			if (durableIds.has(id)) optimisticIds.delete(id);
		}
		batchAtomUpdates(() => {
			syncSessionTurnActivity(liveKey, projection.currentTurn !== null);
			appAtomRegistry.update(messagesBySessionAtom, (state) => {
				const current = state[liveKey] ?? [];
				const pending = current.filter(
					(message) =>
						optimisticIds.has(message.id) && !durableIds.has(message.id),
				);
				return {
					...state,
					[liveKey]: [...durable, ...pending],
				};
			});
			patchQueue(liveKey, projection.queue.items);
			patchQueuePaused(liveKey, projection.queue.paused);
		});
	}
	const reconnecting =
		view.connection === "connecting" ||
		view.connection === "reconnecting" ||
		view.connection === "waking";
	batchAtomUpdates(() => {
		patchReconnecting(liveKey, reconnecting);
		patchError(
			liveKey,
			view.sync === "failed" || view.sync === "stale"
				? "Transcript synchronization failed."
				: view.connection === "failed" || view.connection === "offline"
					? mobileClientBus().connection(retained.environmentId).error
					: null,
		);
	});
};

export const resetMessagesRuntime = async (): Promise<void> => {
	optimisticIds.clear();
	for (const retained of retainedTimelines.values()) {
		retained.unsubscribe();
		retained.lease.release();
	}
	retainedTimelines.clear();
	await resetMobileClientBus();
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
	const retained = retainedTimelines.get(key);
	if (retained === undefined) return;
	retained.unsubscribe();
	retained.lease.release();
	retainedTimelines.delete(key);
};

export const hydrateMessages = async (
	connKey: string,
	options: WsProtocolOptions,
	sessionId: SessionId,
): Promise<void> => {
	const liveKey = connectionSessionKey(connKey, sessionId);
	const existing = retainedTimelines.get(liveKey);
	if (existing !== undefined) {
		existing.lease.activate("connect");
		publishTimeline(liveKey, existing);
		return;
	}
	const environmentId = registerMobileEnvironment(connKey, options);
	const key = sessionTimelineKey(environmentId, sessionId);
	const lease = mobileClientBus().retain(key, { activation: "connect" });
	const retained: RetainedTimeline = {
		environmentId,
		key,
		lease,
		unsubscribe: () => undefined,
	};
	const unsubscribe = mobileClientBus().subscribe(key, () =>
		publishTimeline(liveKey, retained),
	);
	retainedTimelines.set(liveKey, { ...retained, unsubscribe });
	publishTimeline(liveKey, retainedTimelines.get(liveKey) as RetainedTimeline);
};

/**
 * Reopens a retained transcript from an authoritative server snapshot.
 *
 * A mounted RPC stream can appear healthy after its underlying socket has been
 * replaced. Reusing that fiber also reuses its stale current-turn projection,
 * so a screen refresh must replace both rather than treating warm state as
 * proof of liveness.
 */
export const refreshMessages = (
	connKey: string,
	options: WsProtocolOptions,
	sessionId: SessionId,
): Promise<void> => {
	const liveKey = connectionSessionKey(connKey, sessionId);
	const existing = retainedTimelines.get(liveKey);
	if (existing === undefined)
		return hydrateMessages(connKey, options, sessionId);
	const connection = mobileClientBus().connection(existing.environmentId);
	mobileClientBus().reportConnectionFault(
		existing.environmentId,
		{ phase: "failed", message: "Transcript refresh requested." },
		connection.generation,
	);
	existing.lease.activate("connect");
	return Promise.resolve();
};

export const flushMessages = async (
	connKey: string,
	sessionId: SessionId,
): Promise<void> => {
	const liveKey = connectionSessionKey(connKey, sessionId);
	const retained = retainedTimelines.get(liveKey);
	if (retained === undefined) return;
	const view = mobileClientBus().snapshot(retained.key);
	if (
		view.sync !== "live" ||
		view.data === null ||
		view.data.currentTurn !== null
	) {
		return;
	}
	// Active timelines checkpoint continuously in the ClientBus persistence
	// adapter; this compatibility action intentionally does not own another write.
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
		await dispatchSessionCommand(
			connKey,
			options,
			sessionId,
			"messages.queue.delete",
			{
				sessionId,
				queueId,
			},
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
		const updated = await dispatchSessionCommand<QueuedMessage>(
			connKey,
			options,
			sessionId,
			"messages.queue.update",
			{
				sessionId,
				queueId,
				input,
			},
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
			patchError(key, connectionErrorMessage(cause));
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
		const next = await dispatchSessionCommand<readonly QueuedMessage[]>(
			connKey,
			options,
			sessionId,
			"messages.queue.reorder",
			{
				sessionId,
				queueIds: [...queueIds],
			},
		);
		patchQueue(key, next);
	} catch (cause) {
		reportConnectionFailure(options, cause);
		patchQueue(key, previous);
		throw cause;
	}
};

export const runQueuedMessageNext = async (
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
		await dispatchSessionCommand(
			connKey,
			options,
			sessionId,
			"messages.queue.runNext",
			{
				sessionId,
				queueId,
			},
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
		await dispatchSessionCommand(
			connKey,
			options,
			sessionId,
			"messages.queue.resume",
			{ sessionId },
		);
	} catch (cause) {
		reportConnectionFailure(options, cause);
		patchQueuePaused(key, true);
		throw cause;
	}
};

export const addOptimisticMessage = (key: string, message: Message): void => {
	optimisticIds.add(message.id);
	appAtomRegistry.update(messagesBySessionAtom, (state) => {
		const current = state[key] ?? [];
		if (current.some((item) => item.id === message.id)) return state;
		return {
		...state,
			[key]: [...current, message].slice(-500),
		};
	});
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
