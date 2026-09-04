import { CloudCommandTerminalError } from "@zuse/client-runtime/client-persistence";
import {
	resourceRefKey,
	type SessionRef,
} from "@zuse/client-runtime/resource-ref";
import type { SyncPhase } from "@zuse/client-runtime/resource-state";
import {
	CommandId,
	ComposerInput,
	MessageId,
	type ProviderId,
	QueuedMessage,
	QueueState,
	type SessionTimelineProjection,
} from "@zuse/contracts";

import { createAtomStore as create } from "../state/atom-store.ts";
import {
	type CloudFailurePresentation,
	cloudFailurePresentation,
} from "./cloud-failure-presentation.ts";
import { formatError } from "./format-error.ts";
import {
	markRendererInteraction,
	trackRendererRpc,
} from "./performance-marks.ts";
import { makeOptimisticSessionMessage } from "./session-message-intent.ts";
import {
	addOptimisticSessionMessage,
	dispatchSessionCommand,
	dispatchSessionCommandHandle,
	getRendererClientBus,
	removeOptimisticSessionMessage,
	sessionTimelineResourceKey,
	updateOptimisticSessionQueue,
} from "./session-timeline-client-bus.ts";
import { readStorageWithLegacy } from "./storage-keys.ts";

export type ChatError =
	| {
			readonly kind: "auth";
			readonly providerId?: ProviderId;
			readonly message: string;
	  }
	| { readonly kind: "network"; readonly message: string }
	| {
			readonly kind: "terminal";
			readonly category: CloudFailurePresentation["kind"];
			readonly headline: string;
			readonly message: string;
	  }
	| { readonly kind: "generic"; readonly message: string };

const chatErrorForPresentation = (
	presentation: CloudFailurePresentation,
	providerId?: ProviderId,
	originalMessage?: string,
): ChatError => {
	if (presentation.kind === "sign-in-required") {
		return providerId === undefined
			? { kind: "auth", message: originalMessage ?? presentation.message }
			: {
					kind: "auth",
					providerId,
					message: originalMessage ?? presentation.message,
				};
	}
	if (presentation.kind === "network")
		return {
			kind: "network",
			message: originalMessage ?? presentation.message,
		};
	return {
		kind: "terminal",
		category: presentation.kind,
		headline: presentation.headline,
		message: presentation.message,
	};
};

export const classifyMessage = (
	message: string,
	providerId?: ProviderId,
): ChatError => {
	const readable =
		message.trim().length > 0
			? message
			: "The command was rejected without an error description.";
	const presentation = cloudFailurePresentation({ cause: readable });
	if (presentation !== null)
		return chatErrorForPresentation(presentation, providerId, readable);
	return { kind: "generic", message: readable };
};

export const classifyError = (
	cause: unknown,
	providerId?: ProviderId,
): ChatError => {
	if (cause instanceof CloudCommandTerminalError) {
		const presentation = cloudFailurePresentation({
			state: cause.state,
			category: cause.category,
		});
		if (presentation !== null)
			return chatErrorForPresentation(presentation, providerId);
	}
	const presentation = cloudFailurePresentation({ cause });
	if (presentation !== null)
		return chatErrorForPresentation(presentation, providerId);
	return classifyMessage(formatError(cause), providerId);
};

const classifyActionError = (
	cause: unknown,
	fallback: string,
	providerId?: ProviderId,
): ChatError => {
	const classified = classifyError(cause, providerId);
	return classified.kind === "generic"
		? { kind: "generic", message: fallback }
		: classified;
};

type SessionCommandErrorState = {
	readonly errorByResource: Readonly<Record<string, ChatError | null>>;
};

export const useSessionCommandErrors = create<SessionCommandErrorState>(() => ({
	errorByResource: {},
}));

export const sessionCommandErrorKey = (ref: SessionRef): string =>
	resourceRefKey(ref);

const setSessionError = (ref: SessionRef, error: ChatError | null): void => {
	const key = sessionCommandErrorKey(ref);
	useSessionCommandErrors.setState((state) => ({
		errorByResource: { ...state.errorByResource, [key]: error },
	}));
};

export const clearSessionCommandError = (ref: SessionRef): void => {
	setSessionError(ref, null);
	getRendererClientBus().dismissFailedCommands(sessionTimelineResourceKey(ref));
};

export const isRecoveredPreAckSessionError = (
	error: ChatError | string,
	timeline: Readonly<{ data: unknown | null; sync: SyncPhase }>,
): boolean => {
	const sessionUnavailable =
		typeof error === "string"
			? cloudFailurePresentation({ cause: error })?.kind ===
				"session-unavailable"
			: error.kind === "terminal" && error.category === "session-unavailable";
	return (
		sessionUnavailable && timeline.data !== null && timeline.sync === "live"
	);
};

/** A persisted optimistic row is runnable only after its durable add receipt. */
export const optimisticQueuedMessageReady = (options?: {
	readonly persist?: boolean;
	readonly ready?: boolean;
}): boolean => (options?.persist === false ? (options.ready ?? true) : false);

const projectionFor = (ref: SessionRef): SessionTimelineProjection | null =>
	getRendererClientBus().snapshot(sessionTimelineResourceKey(ref)).data;

const retryableFailure = (ref: SessionRef, commandId: CommandId): boolean =>
	getRendererClientBus()
		.snapshot(sessionTimelineResourceKey(ref))
		.failedCommands.some(
			(command) => command.commandId === commandId && command.retryable,
		);

export const pendingSessionCommandError = (
	ref: SessionRef,
): ChatError | null => {
	const view = getRendererClientBus().snapshot(sessionTimelineResourceKey(ref));
	const failed = view.failedCommands.at(-1);
	if (failed === undefined) return null;
	// A provisional chat can briefly receive a session-scoped command before its
	// durable creation acknowledgement. Once the authoritative timeline is live,
	// that earlier not-found result is obsolete and must not survive as a provider
	// failure banner over a healthy, streaming turn.
	if (isRecoveredPreAckSessionError(failed.error, view)) {
		return null;
	}
	// Retriable failures remain in the durable outbox and are represented by the
	// shared stale/connection phase. A destructive error bubble would imply the
	// prompt was rejected even though reconnect will replay it.
	if (failed.retryable) return null;
	return failed.terminal === undefined
		? classifyMessage(failed.error)
		: classifyError(
				new CloudCommandTerminalError(
					failed.terminal.state,
					failed.terminal.category,
					failed.error,
					failed.failedAt,
				),
			);
};

const dispatch = <Payload, Result>(
	ref: SessionRef,
	kind: string,
	commandId: CommandId,
	payload: Payload,
) => dispatchSessionCommand<Payload, Result>({ ref, kind, commandId, payload });

const SESSION_MODEL_OPTION_KEYS = [
	"reasoning",
	"effort",
	"fastMode",
	"thinking",
	"contextWindow",
] as const;

export const sessionModelOptionStorageKey = (
	ref: SessionRef,
	key: string,
): string => `zuse.modelOptions.${resourceRefKey(ref)}.${key}`;

const readSessionModelOptions = (
	ref: SessionRef,
): Record<string, string> | null => {
	if (typeof window === "undefined") return null;
	const result: Record<string, string> = {};
	for (const key of SESSION_MODEL_OPTION_KEYS) {
		const value = readStorageWithLegacy(
			window.sessionStorage,
			sessionModelOptionStorageKey(ref, key),
			[
				`zuse.modelOptions.${ref.sessionId}.${key}`,
				`memoize.modelOptions.${ref.sessionId}.${key}`,
			],
		);
		if (value !== null && value.length > 0) result[key] = value;
	}
	if (result.reasoning === undefined) {
		const legacy = readStorageWithLegacy(
			window.sessionStorage,
			`zuse.reasoning.${resourceRefKey(ref)}`,
			[`zuse.reasoning.${ref.sessionId}`, `memoize.reasoning.${ref.sessionId}`],
		);
		if (legacy !== null && legacy.length > 0) result.reasoning = legacy;
	}
	return Object.keys(result).length === 0 ? null : result;
};

export const sendSessionMessage = async (
	ref: SessionRef,
	input: string | ComposerInput,
	options?: { readonly asGoal?: boolean; readonly providerId?: ProviderId },
): Promise<boolean> => {
	const messageId = MessageId.make(crypto.randomUUID());
	const message = makeOptimisticSessionMessage({
		sessionId: ref.sessionId,
		messageId,
		content: input,
		asGoal: options?.asGoal === true,
		createdAt: new Date(),
	});
	addOptimisticSessionMessage(ref, message);
	setSessionError(ref, null);
	const commandId = CommandId.make(`message-send:${messageId}`);
	const modelOptions = readSessionModelOptions(ref);
	const payload = {
		commandId,
		sessionId: ref.sessionId,
		...(typeof input === "string" ? { text: input } : { input }),
		...(options?.asGoal === undefined ? {} : { asGoal: options.asGoal }),
		clientMessageId: messageId,
		...(modelOptions === null ? {} : { modelOptions }),
	};
	try {
		const handle = dispatchSessionCommandHandle<typeof payload, void>({
			ref,
			kind: "messages.send",
			commandId,
			payload,
		});
		await handle.accepted;
		void handle.result.catch((cause) => {
			if (retryableFailure(ref, commandId)) return;
			removeOptimisticSessionMessage(ref, messageId);
			setSessionError(ref, classifyError(cause, options?.providerId));
		});
		return true;
	} catch (cause) {
		// A transport failure is ambiguous, but there is no locally durable mailbox
		// acceptance confirmation yet. Keep the outbox and optimistic prompt for
		// retry while reporting false so the composer remains recoverable.
		if (retryableFailure(ref, commandId)) return false;
		removeOptimisticSessionMessage(ref, messageId);
		setSessionError(ref, classifyError(cause, options?.providerId));
		return false;
	}
};

export const interruptSession = async (
	ref: SessionRef,
	providerId?: ProviderId,
): Promise<void> => {
	setSessionError(ref, null);
	const expectedTurnId = projectionFor(ref)?.currentTurn?.turnId;
	const commandId = CommandId.make(
		`message-interrupt:${ref.sessionId}:${expectedTurnId ?? "none"}`,
	);
	try {
		await dispatch(ref, "messages.interrupt", commandId, {
			commandId,
			sessionId: ref.sessionId,
			expectedTurnId,
		});
	} catch (cause) {
		if (retryableFailure(ref, commandId)) return;
		setSessionError(
			ref,
			classifyActionError(
				cause,
				"Couldn’t stop the current turn. Try again.",
				providerId,
			),
		);
	}
};

const updateQueue = (
	ref: SessionRef,
	update: (items: readonly QueuedMessage[]) => readonly QueuedMessage[],
): void => {
	updateOptimisticSessionQueue(ref, (queue) =>
		QueueState.make({ items: [...update(queue.items)], paused: queue.paused }),
	);
};

const setQueuePaused = (ref: SessionRef, paused: boolean): void => {
	updateOptimisticSessionQueue(ref, (queue) =>
		QueueState.make({ items: [...queue.items], paused }),
	);
};

export const persistQueuedMessage = async (
	ref: SessionRef,
	queueId: string,
	input: ComposerInput,
	options?: {
		readonly ready?: boolean;
		readonly flush?: boolean;
		readonly providerId?: ProviderId;
	},
): Promise<void> => {
	const commandId = CommandId.make(
		`queue-add:${ref.sessionId}:${queueId}:${crypto.randomUUID()}`,
	);
	const payload = {
		commandId,
		sessionId: ref.sessionId,
		queueId,
		input,
		...(options?.ready === undefined ? {} : { ready: options.ready }),
		...(options?.flush === undefined ? {} : { flush: options.flush }),
	};
	try {
		const item = await trackRendererRpc(
			"messages.queue.add",
			async () =>
				(
					await dispatch<typeof payload, QueuedMessage>(
						ref,
						"messages.queue.add",
						commandId,
						payload,
					)
				).result,
		);
		updateQueue(ref, (items) =>
			items.map((queued) => (queued.id === queueId ? item : queued)),
		);
		markRendererInteraction(ref.sessionId, "queue-persisted");
		setSessionError(ref, null);
	} catch (cause) {
		if (retryableFailure(ref, commandId)) return;
		// The optimistic item never became durable. Leaving it disabled implies it
		// will eventually run even after an authoritative domain rejection.
		updateQueue(ref, (items) => items.filter((item) => item.id !== queueId));
		setSessionError(ref, classifyError(cause, options?.providerId));
	}
};

export const queueSessionMessage = (
	ref: SessionRef,
	input: ComposerInput,
	options?: {
		readonly queueId?: string;
		readonly persist?: boolean;
		readonly ready?: boolean;
		readonly flush?: boolean;
		readonly providerId?: ProviderId;
	},
): string => {
	const queueId = options?.queueId ?? `q_${crypto.randomUUID()}`;
	const current = projectionFor(ref)?.queue.items ?? [];
	if (!current.some((item) => item.id === queueId)) {
		const now = new Date();
		const item = QueuedMessage.make({
			id: queueId,
			sessionId: ref.sessionId,
			input,
			position: current.length,
			createdAt: now,
			updatedAt: now,
			ready: optimisticQueuedMessageReady(options),
		});
		updateQueue(ref, (items) => [...items, item]);
	}
	if (options?.persist !== false) {
		void persistQueuedMessage(ref, queueId, input, options);
	}
	return queueId;
};

const isQueuedMessageNotFound = (cause: unknown): boolean =>
	typeof cause === "object" &&
	cause !== null &&
	"_tag" in cause &&
	cause._tag === "QueuedMessageNotFoundError";

export const updateQueuedMessage = async (
	ref: SessionRef,
	queueId: string,
	input: ComposerInput,
	providerId?: ProviderId,
): Promise<void> => {
	const previous = projectionFor(ref)?.queue.items.find(
		(item) => item.id === queueId,
	);
	updateQueue(ref, (items) =>
		items.map((item) =>
			item.id === queueId
				? QueuedMessage.make({
						...item,
						input,
						ready: true,
						updatedAt: new Date(),
					})
				: item,
		),
	);
	const commandId = CommandId.make(
		`queue-update:${ref.sessionId}:${queueId}:${crypto.randomUUID()}`,
	);
	try {
		const updated = (
			await dispatch(ref, "messages.queue.update", commandId, {
				commandId,
				sessionId: ref.sessionId,
				queueId,
				input,
			})
		).result as QueuedMessage;
		updateQueue(ref, (items) =>
			items.map((item) => (item.id === queueId ? updated : item)),
		);
	} catch (cause) {
		if (retryableFailure(ref, commandId)) return;
		if (isQueuedMessageNotFound(cause)) {
			// The queue stream may lag behind the server consuming or deleting this
			// item. Not-found is authoritative convergence, not a provider failure:
			// drop any stale optimistic row and never resurrect an already-run prompt.
			updateQueue(ref, (items) => items.filter((item) => item.id !== queueId));
			clearSessionCommandError(ref);
			return;
		}
		if (previous !== undefined) {
			updateQueue(ref, (items) =>
				items.map((item) => (item.id === queueId ? previous : item)),
			);
		}
		setSessionError(ref, classifyError(cause, providerId));
	}
};

export const reorderSessionQueue = (
	ref: SessionRef,
	queueIds: readonly string[],
	providerId?: ProviderId,
): void => {
	const previous = projectionFor(ref)?.queue.items ?? [];
	const byId = new Map(previous.map((item) => [item.id, item]));
	const ordered = [
		...queueIds.flatMap((id) => {
			const item = byId.get(id);
			if (item === undefined) return [];
			byId.delete(id);
			return [item];
		}),
		...previous.filter((item) => byId.has(item.id)),
	].map((item, position) => QueuedMessage.make({ ...item, position }));
	updateQueue(ref, () => ordered);
	const commandId = CommandId.make(
		`queue-reorder:${ref.sessionId}:${crypto.randomUUID()}`,
	);
	void dispatch(ref, "messages.queue.reorder", commandId, {
		commandId,
		sessionId: ref.sessionId,
		queueIds,
	}).catch((cause) => {
		if (retryableFailure(ref, commandId)) return;
		updateQueue(ref, () => previous);
		setSessionError(ref, classifyError(cause, providerId));
	});
};

export const flushSessionQueue = (
	ref: SessionRef,
	providerId?: ProviderId,
): void => {
	const commandId = CommandId.make(
		`queue-flush:${ref.sessionId}:${crypto.randomUUID()}`,
	);
	void dispatch(ref, "messages.queue.flush", commandId, {
		commandId,
		sessionId: ref.sessionId,
	}).catch((cause) => {
		if (!retryableFailure(ref, commandId)) {
			setSessionError(ref, classifyError(cause, providerId));
		}
	});
};

export const resumeSessionQueue = async (
	ref: SessionRef,
	providerId?: ProviderId,
): Promise<void> => {
	setQueuePaused(ref, false);
	const commandId = CommandId.make(
		`queue-resume:${ref.sessionId}:${crypto.randomUUID()}`,
	);
	try {
		await dispatch(ref, "messages.queue.resume", commandId, {
			commandId,
			sessionId: ref.sessionId,
		});
	} catch (cause) {
		if (retryableFailure(ref, commandId)) return;
		setQueuePaused(ref, true);
		setSessionError(ref, classifyError(cause, providerId));
	}
};

const deleteQueuedMessage = async (
	ref: SessionRef,
	queueId: string,
): Promise<void> => {
	const commandId = CommandId.make(
		`queue-delete:${ref.sessionId}:${queueId}:${crypto.randomUUID()}`,
	);
	try {
		await dispatch(ref, "messages.queue.delete", commandId, {
			commandId,
			sessionId: ref.sessionId,
			queueId,
		});
	} catch (cause) {
		// Once retained in the durable outbox this deletion is accepted client
		// intent. Re-adding the row would race its reconnect replay.
		if (retryableFailure(ref, commandId)) return;
		throw cause;
	}
};

const restoreQueuedItem = (ref: SessionRef, item: QueuedMessage): void => {
	updateQueue(ref, (items) =>
		items.some((candidate) => candidate.id === item.id)
			? items
			: [...items, item].sort((left, right) => left.position - right.position),
	);
};

export const dropQueuedMessage = (
	ref: SessionRef,
	queueId: string,
	providerId?: ProviderId,
): void => {
	const item = projectionFor(ref)?.queue.items.find(
		(candidate) => candidate.id === queueId,
	);
	if (item === undefined) return;
	updateQueue(ref, (items) =>
		items.filter((candidate) => candidate.id !== queueId),
	);
	void deleteQueuedMessage(ref, queueId).catch((cause) => {
		restoreQueuedItem(ref, item);
		setSessionError(ref, classifyError(cause, providerId));
	});
};

export const takeQueuedMessageForEdit = async (
	ref: SessionRef,
	queueId: string,
	providerId?: ProviderId,
): Promise<QueuedMessage | null> => {
	const item = projectionFor(ref)?.queue.items.find(
		(candidate) => candidate.id === queueId,
	);
	if (item === undefined) return null;
	updateQueue(ref, (items) =>
		items.filter((candidate) => candidate.id !== queueId),
	);
	try {
		await deleteQueuedMessage(ref, queueId);
		return item;
	} catch (cause) {
		restoreQueuedItem(ref, item);
		setSessionError(
			ref,
			classifyActionError(
				cause,
				"Couldn’t open that queued message for editing. Try again.",
				providerId,
			),
		);
		return null;
	}
};

export const runQueuedMessageNext = async (
	ref: SessionRef,
	queueId: string,
	providerId?: ProviderId,
): Promise<void> => {
	const item = projectionFor(ref)?.queue.items.find(
		(candidate) => candidate.id === queueId,
	);
	if (item === undefined) return;
	updateQueue(ref, (items) =>
		items.filter((candidate) => candidate.id !== queueId),
	);
	const commandId = CommandId.make(
		`queue-run-next:${ref.sessionId}:${queueId}:${crypto.randomUUID()}`,
	);
	try {
		await dispatch(ref, "messages.queue.runNext", commandId, {
			commandId,
			sessionId: ref.sessionId,
			queueId,
		});
	} catch (cause) {
		if (retryableFailure(ref, commandId)) return;
		restoreQueuedItem(ref, item);
		setSessionError(
			ref,
			classifyActionError(
				cause,
				"Couldn’t run that message next. It is still in your queue.",
				providerId,
			),
		);
	}
};

export const retryLastSessionMessage = async (
	ref: SessionRef,
	providerId?: ProviderId,
): Promise<boolean> => {
	const messages = projectionFor(ref)?.messages ?? [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const content = messages[index]?.content;
		if (content?._tag === "user_rich") {
			return sendSessionMessage(
				ref,
				ComposerInput.make({
					text: content.text,
					attachments: content.attachments,
					fileRefs: content.fileRefs,
					skillRefs: content.skillRefs,
					annotations: content.annotations,
				}),
				{ providerId },
			);
		}
		if (content?._tag === "user") {
			return sendSessionMessage(ref, content.text, { providerId });
		}
	}
	return false;
};
