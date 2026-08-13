import { CommandId, type SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";

import { connectionSessionKey } from "~/lib/session-key";
import type { QueuedMessage } from "~/offline/cache";
import {
	deletePath,
	outboxPath,
	readOutboxSnapshot,
	writeOutboxSnapshot,
} from "~/offline/cache";
import { makeTextInput } from "~/rpc/actions";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

import {
	sessionCommandContext,
	stageMobileSessionCommand,
} from "./mobile-client-bus";
import { appAtomRegistry, batchAtomUpdates } from "./registry";

/**
 * Editable drafts created while a session is offline. These rows intentionally
 * are not executable commands: the user may still edit or cancel them. Once a
 * connection is available, `submitOutboxDrafts` transfers each row exactly once
 * into the durable ClientBus command outbox using its stable client ID and then
 * removes the draft. ClientBus is the sole retry/receipt owner after transfer.
 */
export const queuedBySessionAtom = Atom.make<
	Record<string, readonly QueuedMessage[]>
>({}).pipe(Atom.keepAlive);

const EMPTY_QUEUED: readonly QueuedMessage[] = [];

/** Per-session drafts; notifies only when this session's drafts change. */
export const queuedMessagesAtom = Atom.family((key: string) =>
	Atom.make((get) => get(queuedBySessionAtom)[key] ?? EMPTY_QUEUED),
);

const pendingWrites = new Set<Promise<void>>();
let counter = 0;

const makeClientId = () =>
	`offline-queue:${Date.now().toString(36)}:${(counter++).toString(36)}`;

const persist = (
	connKey: string,
	sessionId: SessionId,
	items: readonly QueuedMessage[],
): Promise<void> => {
	const write = Effect.runPromise(
		items.length === 0
			? deletePath(outboxPath(connKey, sessionId))
			: writeOutboxSnapshot(connKey, sessionId, { items }),
	).catch(() => undefined);
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

export const resetOutboxRuntime = async (): Promise<void> => {
	await Promise.allSettled([...pendingWrites]);
	appAtomRegistry.set(queuedBySessionAtom, {});
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
	patchQueued(key, cached?.items ?? []);
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
	const next = [...(appAtomRegistry.get(queuedBySessionAtom)[key] ?? []), item];
	patchQueued(key, next);
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

export const submitOutboxDrafts = async (
	connKey: string,
	options: WsProtocolOptions,
	sessionId: SessionId,
): Promise<void> => {
	const key = connectionSessionKey(connKey, sessionId);
	const queued = appAtomRegistry.get(queuedBySessionAtom)[key] ?? [];
	if (queued.length === 0) return;
	const { environmentId, resource } = sessionCommandContext(
		connKey,
		options,
		sessionId,
	);

	// Stage each safe command durably before deleting its editable source draft.
	// After the stage commits, ClientBus is the sole retry and receipt owner.
	for (const item of queued) {
		const commandId = CommandId.make(item.clientId);
		await stageMobileSessionCommand({
			kind: "messages.queue.add",
			commandId,
			environmentId,
			resource,
			payload: {
				commandId,
				sessionId,
				queueId: item.clientId,
				input: makeTextInput(item.text, [], item.asGoal),
			},
			retry: "safe",
			createdAt: item.createdAt,
		});
	}
	batchAtomUpdates(() => patchQueued(key, []));
	await persist(connKey, sessionId, []);
};
