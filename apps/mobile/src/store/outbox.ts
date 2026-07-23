import type { SessionId } from "@zuse/contracts";
import { Effect, Fiber } from "effect";
import { Atom } from "effect/unstable/reactivity";

import { connectionSessionKey } from "~/lib/session-key";
import type { QueuedMessage } from "~/offline/cache";
import { readOutboxSnapshot, writeOutboxSnapshot } from "~/offline/cache";
import { flushServerQueue, makeTextInput, queueMessage } from "~/rpc/actions";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

import { appAtomRegistry, batchAtomUpdates } from "./registry";

/**
 * Per-session outbox for messages composed while the session is offline. Items
 * are persisted to disk on every mutation so a force-quit doesn't lose queued
 * text, and flushed in order the moment the session reconnects. Flush keeps the
 * server-generated message id (no `clientMessageId`) — the live stream echoes
 * the row back and the message store dedupes by id.
 */
export const queuedBySessionAtom = Atom.make<
	Record<string, readonly QueuedMessage[]>
>({}).pipe(Atom.keepAlive);
export const outboxSendingBySessionAtom = Atom.make<Record<string, boolean>>(
	{},
).pipe(Atom.keepAlive);
export const outboxErrorBySessionAtom = Atom.make<
	Record<string, string | null>
>({}).pipe(Atom.keepAlive);

const EMPTY_QUEUED: readonly QueuedMessage[] = [];

/** Per-session queue; notifies only when this session's queue changes. */
export const queuedMessagesAtom = Atom.family((key: string) =>
	Atom.make((get) => get(queuedBySessionAtom)[key] ?? EMPTY_QUEUED),
);

// In-flight guard so a reconnect burst can't start two overlapping flushes for
// the same session (which would double-send the head of the queue).
const flushing = new Set<string>();
const activeFlushFibers = new Map<string, Fiber.Fiber<unknown, unknown>>();
const flushDrainWaiters = new Set<() => void>();
const pendingWrites = new Set<Promise<void>>();
let resetGeneration = 0;
let resetting = false;
let counter = 0;

const makeClientId = () =>
	`${Date.now().toString(36)}-${(counter++).toString(36)}`;

const persist = (
	connKey: string,
	sessionId: SessionId,
	items: readonly QueuedMessage[],
) => {
	const write = Effect.runPromise(
		writeOutboxSnapshot(connKey, sessionId, { items }),
	).catch(() => {});
	pendingWrites.add(write);
	void write.finally(() => pendingWrites.delete(write));
	return write;
};

const patchQueued = (key: string, items: readonly QueuedMessage[]): void => {
	appAtomRegistry.update(queuedBySessionAtom, (state) => ({
		...state,
		[key]: items,
	}));
};

const patchError = (key: string, error: string | null): void => {
	appAtomRegistry.update(outboxErrorBySessionAtom, (state) => ({
		...state,
		[key]: error,
	}));
};

export const resetOutboxRuntime = async (): Promise<void> => {
	resetting = true;
	resetGeneration += 1;
	const fibers = [...activeFlushFibers.values()];
	activeFlushFibers.clear();
	await Promise.all(
		fibers.map((fiber) =>
			Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {}),
		),
	);
	if (flushing.size > 0) {
		await new Promise<void>((resolve) => flushDrainWaiters.add(resolve));
	}
	await Promise.allSettled([...pendingWrites]);
	batchAtomUpdates(() => {
		appAtomRegistry.set(queuedBySessionAtom, {});
		appAtomRegistry.set(outboxSendingBySessionAtom, {});
		appAtomRegistry.set(outboxErrorBySessionAtom, {});
	});
	resetting = false;
};

export const hydrateOutbox = async (
	connKey: string,
	sessionId: SessionId,
): Promise<void> => {
	const key = connectionSessionKey(connKey, sessionId);
	if (appAtomRegistry.get(queuedBySessionAtom)[key] !== undefined) return;
	const cached = await Effect.runPromise(
		readOutboxSnapshot(connKey, sessionId),
	).catch(() => null);
	const items = cached?.items ?? [];
	batchAtomUpdates(() => {
		patchQueued(key, items);
		appAtomRegistry.update(outboxSendingBySessionAtom, (state) => ({
			...state,
			[key]: false,
		}));
		patchError(key, null);
	});
};

export const enqueueOutboxMessage = async (
	connKey: string,
	sessionId: SessionId,
	text: string,
	asGoal?: boolean,
): Promise<void> => {
	const trimmed = text.trim();
	if (trimmed.length === 0) return;
	const item: QueuedMessage = {
		clientId: makeClientId(),
		text: trimmed,
		...(asGoal === undefined ? {} : { asGoal }),
		createdAt: Date.now(),
	};
	const key = connectionSessionKey(connKey, sessionId);
	const next = [
		...(appAtomRegistry.get(queuedBySessionAtom)[key] ?? []),
		item,
	];
	batchAtomUpdates(() => {
		patchQueued(key, next);
		patchError(key, null);
	});
	await persist(connKey, sessionId, next);
};

export const cancelOutboxMessage = async (
	connKey: string,
	sessionId: SessionId,
	clientId: string,
): Promise<void> => {
	const key = connectionSessionKey(connKey, sessionId);
	const next = (appAtomRegistry.get(queuedBySessionAtom)[key] ?? []).filter(
		(item) => item.clientId !== clientId,
	);
	patchQueued(key, next);
	await persist(connKey, sessionId, next);
};

export const updateOutboxMessage = async (
	connKey: string,
	sessionId: SessionId,
	clientId: string,
	text: string,
): Promise<void> => {
	const trimmed = text.trim();
	if (trimmed.length === 0) return;
	const key = connectionSessionKey(connKey, sessionId);
	const next = (appAtomRegistry.get(queuedBySessionAtom)[key] ?? []).map(
		(item) => (item.clientId === clientId ? { ...item, text: trimmed } : item),
	);
	patchQueued(key, next);
	await persist(connKey, sessionId, next);
};

export const flushOutbox = async (
	connKey: string,
	options: WsProtocolOptions,
	sessionId: SessionId,
): Promise<void> => {
	const key = connectionSessionKey(connKey, sessionId);
	if (resetting || flushing.has(key)) return;
	const queued = appAtomRegistry.get(queuedBySessionAtom)[key] ?? [];
	if (queued.length === 0) return;
	const generation = resetGeneration;
	flushing.add(key);
	batchAtomUpdates(() => {
		appAtomRegistry.update(outboxSendingBySessionAtom, (state) => ({
			...state,
			[key]: true,
		}));
		patchError(key, null);
	});
	try {
		// Hand local offline items to the server queue in order. Once accepted by
		// the server, the item is no longer local state; server queue flushing is
		// responsible for waiting until the session is idle.
		let remaining = queued;
		for (const item of queued) {
			try {
				const fiber = Effect.runFork(
					queueMessage({
						connection: options,
						sessionId,
						input: makeTextInput(item.text, [], item.asGoal),
						queueId: item.clientId,
					}),
				);
				activeFlushFibers.set(key, fiber);
				await Effect.runPromise(Fiber.join(fiber));
				if (activeFlushFibers.get(key) === fiber) {
					activeFlushFibers.delete(key);
				}
			} catch (cause) {
				activeFlushFibers.delete(key);
				if (generation !== resetGeneration) return;
				const reason = messageOf(cause);
				console.warn("[mobile] outbox.queue_add_failed", {
					sessionId,
					reason,
				});
				patchError(key, `Could not queue message: ${reason}`);
				break;
			}
			if (generation !== resetGeneration) return;
			remaining = remaining.filter((entry) => entry.clientId !== item.clientId);
			patchQueued(key, remaining);
			await persist(connKey, sessionId, remaining);
			if (generation !== resetGeneration) return;
			const flushFiber = Effect.runFork(
				flushServerQueue({ connection: options, sessionId }),
			);
			activeFlushFibers.set(key, flushFiber);
			await Effect.runPromise(Fiber.join(flushFiber)).catch((cause) => {
				console.warn("[mobile] outbox.flush_failed", {
					sessionId,
					reason: messageOf(cause),
				});
			});
			if (activeFlushFibers.get(key) === flushFiber) {
				activeFlushFibers.delete(key);
			}
			if (generation !== resetGeneration) return;
		}
	} finally {
		activeFlushFibers.delete(key);
		flushing.delete(key);
		if (generation === resetGeneration) {
			appAtomRegistry.update(outboxSendingBySessionAtom, (state) => ({
				...state,
				[key]: false,
			}));
		}
		if (flushing.size === 0) {
			for (const resolve of flushDrainWaiters) resolve();
			flushDrainWaiters.clear();
		}
	}
};

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);
