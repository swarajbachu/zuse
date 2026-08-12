import {
	Chat,
	CloudChatHistory,
	type CloudChatSummary,
	type CloudWorkspace,
	type FolderId,
	type GitOriginInfo,
	Message,
	MessageId,
	type ProviderId,
	Session,
	SessionId,
} from "@zuse/contracts";
import { Effect } from "effect";
import {
	cloudChatSnapshotStore,
	makeCloudChatSnapshot,
} from "../lib/cloud-chat-snapshot-store.ts";
import { formatError } from "../lib/format-error.ts";
import {
	getControlPlaneRpcClient,
	getRpcClient,
	registerCloudWorkspace,
	setDefaultRpcEnvironmentResolver,
} from "../lib/rpc-client.ts";
import {
	effectiveSessionRuntimeState,
	isSessionRuntimeBusy,
} from "../lib/session-runtime-state.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { useArchivePreviewStore } from "./archive-preview.ts";
import { useChatsStore } from "./chats.ts";
import {
	type CloudAttachmentState,
	cloudExecutionTarget,
	cloudSummaryForChat,
	localProjectForCloudChat,
	registerCloudChat,
	registerCloudExecutionTarget,
	setCloudAttachmentState,
	useCloudExecutionStore,
} from "./cloud-chat-registry.ts";
import {
	acknowledgeTimelineSessionCreated,
	useMessagesStore,
} from "./messages.ts";
import { markQueueHydrated } from "./queue-hydration.ts";
import { useSessionRuntimeStore } from "./session-runtime.ts";
import { useSessionsStore } from "./sessions.ts";

type CloudChatsState = {
	readonly summaries: ReadonlyArray<CloudChatSummary>;
	readonly historyLoadingByChat: Readonly<Record<string, boolean>>;
	readonly loading: boolean;
	readonly error: string | null;
	readonly hydrate: () => Promise<void>;
	readonly archive: (summary: CloudChatSummary) => Promise<void>;
};

const opening = new Map<string, Promise<void>>();
const attaching = new Map<string, Promise<void>>();

setDefaultRpcEnvironmentResolver(() => {
	const chatId = useChatsStore.getState().selectedChatId;
	if (chatId === null) return undefined;
	const summary = cloudSummaryForChat(chatId);
	if (summary === null) return undefined;
	return cloudExecutionTarget(summary.workspaceId)?.workspaceId;
});
let hydration: Promise<void> | null = null;
const histories = new Map<string, CloudChatHistory>();
const historyPumps = new Map<string, Promise<void>>();
const snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();

const CLOUD_HISTORY_POLL_MS = 250;

export const runCloudHistoryPump = async (input: {
	readonly initialCursor: number;
	readonly isActive: () => boolean;
	readonly fetchAfter: (cursor: number) => Promise<CloudChatHistory>;
	readonly apply: (history: CloudChatHistory) => void;
	readonly wait?: () => Promise<void>;
}): Promise<void> => {
	let cursor = input.initialCursor;
	const wait =
		input.wait ??
		(() =>
			new Promise<void>((resolve) =>
				setTimeout(resolve, CLOUD_HISTORY_POLL_MS),
			));
	while (input.isActive()) {
		try {
			const history = await input.fetchAfter(cursor);
			cursor = Math.max(cursor, history.cursor);
			input.apply(history);
		} catch {
			// A transient control-plane failure must not terminate live delivery.
		}
		if (input.isActive()) await wait();
	}
};

const mergeCloudChatHistory = (
	current: CloudChatHistory | null,
	incoming: CloudChatHistory,
): CloudChatHistory => {
	if (current === null) return incoming;
	const events = new Map(
		current.events.map((event) => [event.sequence, event] as const),
	);
	for (const event of incoming.events) events.set(event.sequence, event);
	const queued = new Map(
		current.queuedMessages.map((message) => [message.clientMessageId, message]),
	);
	for (const message of incoming.queuedMessages)
		queued.set(message.clientMessageId, message);
	return CloudChatHistory.make({
		workspaceId: incoming.workspaceId,
		chatId: incoming.chatId,
		initialSessionId: incoming.initialSessionId,
		firstMessage: incoming.firstMessage ?? current.firstMessage,
		commandState: incoming.commandState,
		events: [...events.values()].sort((a, b) => a.sequence - b.sequence),
		queuedMessages: [...queued.values()],
		cursor: Math.max(current.cursor, incoming.cursor),
	});
};

const persistCloudChatSnapshot = (
	summary: CloudChatSummary,
	projectId: FolderId,
): void => {
	if (cloudChatSnapshotStore === null) return;
	const previous = snapshotTimers.get(summary.workspaceId);
	if (previous !== undefined) clearTimeout(previous);
	snapshotTimers.set(
		summary.workspaceId,
		setTimeout(() => {
			snapshotTimers.delete(summary.workspaceId);
			const latest = cloudSummaryForChat(summary.chatId) ?? summary;
			const history =
				histories.get(summary.workspaceId) ??
				CloudChatHistory.make({
					workspaceId: latest.workspaceId,
					chatId: latest.chatId,
					initialSessionId: latest.initialSessionId,
					commandState: "queued",
					events: [],
					queuedMessages: [],
					cursor: 0,
				});
			histories.set(summary.workspaceId, history);
			void cloudChatSnapshotStore
				?.save(
					makeCloudChatSnapshot({
						projectId,
						summary: latest,
						history,
						messages:
							useMessagesStore.getState().messagesBySession[
								latest.initialSessionId
							] ?? [],
					}),
				)
				.catch(() => {});
		}, 100),
	);
};

const refreshSummaryFromWorkspace = (
	summary: CloudChatSummary,
	workspace: CloudWorkspace,
): CloudChatSummary => ({
	...summary,
	state: workspace.state,
	runtimeState: workspace.runtimeState,
	statusCode: workspace.statusCode,
	startupPhase: workspace.startupPhase,
	desiredState: workspace.desiredState,
	revision: workspace.revision,
	updatedAt: workspace.updatedAt,
});

const updateSummary = (summary: CloudChatSummary): void => {
	const current = cloudSummaryForChat(summary.chatId);
	if (
		current !== null &&
		(current.revision > summary.revision ||
			(current.revision === summary.revision &&
				current.updatedAt >= summary.updatedAt))
	)
		return;
	const projectId = localProjectForCloudChat(summary.chatId);
	if (projectId !== null) {
		ensureCloudChatProjected(summary, projectId);
		persistCloudChatSnapshot(summary, projectId);
	}
	useCloudChatsStore.setState((state) => ({
		summaries: mergeCloudChatSummaries(state.summaries, [summary]),
	}));
};

const ensureCloudChatProjected = (
	summary: CloudChatSummary,
	projectId: FolderId,
): void => {
	const existing = useChatsStore
		.getState()
		.chatsByProject[projectId]?.find((chat) => chat.id === summary.chatId);
	const archivedAt =
		summary.archivedAt === undefined ? null : new Date(summary.archivedAt);
	if (
		existing === undefined ||
		existing.title !== summary.title ||
		existing.archivedAt?.getTime() !== archivedAt?.getTime()
	) {
		stageCloudChat(summary, projectId);
		return;
	}
	registerCloudChat(summary, projectId);
};

export const mergeCloudChatSummaries = (
	current: ReadonlyArray<CloudChatSummary>,
	incoming: ReadonlyArray<CloudChatSummary>,
): ReadonlyArray<CloudChatSummary> => {
	const byChat = new Map(current.map((summary) => [summary.chatId, summary]));
	for (const summary of incoming) {
		const previous = byChat.get(summary.chatId);
		if (previous === undefined || summary.revision > previous.revision)
			byChat.set(summary.chatId, summary);
		else if (summary.revision === previous.revision)
			byChat.set(summary.chatId, {
				...previous,
				unread: previous.unread || summary.unread,
				lastMessageAt:
					previous.lastMessageAt === null
						? summary.lastMessageAt
						: summary.lastMessageAt === null
							? previous.lastMessageAt
							: Math.max(previous.lastMessageAt, summary.lastMessageAt),
			});
	}
	return [...byChat.values()].sort(
		(a, b) =>
			(b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt),
	);
};

export const mergeCloudChatMessages = (
	current: ReadonlyArray<Message>,
	incoming: ReadonlyArray<Message>,
): ReadonlyArray<Message> => {
	const byId = new Map(current.map((message) => [message.id, message]));
	for (const message of incoming) byId.set(message.id, message);
	return [...byId.values()].sort(
		(a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
	);
};

export const shouldAttachCloudChatOnOpen = (
	summary: CloudChatSummary,
): boolean => summary.state === "ready" && summary.runtimeState === "online";

export const canReuseCloudWorkspaceAttachment = (input: {
	readonly summary: Pick<CloudChatSummary, "state" | "runtimeState">;
	readonly attachmentState: CloudAttachmentState | undefined;
	readonly hasExecutionTarget: boolean;
}): boolean =>
	input.attachmentState === "ready" &&
	input.hasExecutionTarget &&
	input.summary.state === "ready" &&
	input.summary.runtimeState === "online";

export const attachCloudTranscriptLive = (
	summary: Pick<CloudChatSummary, "initialSessionId" | "workspaceId">,
	hydrate: (
		sessionId: SessionId,
		options: { readonly live: true; readonly environmentId: string },
	) => Promise<void> = useMessagesStore.getState().hydrate,
): Promise<void> =>
	hydrate(SessionId.make(summary.initialSessionId), {
		live: true,
		environmentId: summary.workspaceId,
	});

export const shouldAttachCloudChatWithPendingCommands = (
	history: Pick<CloudChatHistory, "commandState" | "queuedMessages">,
): boolean =>
	history.commandState === "queued" ||
	history.commandState === "claimed" ||
	history.queuedMessages.some(
		(message) => message.state === "queued" || message.state === "claimed",
	);

export const shouldUseLocalMessageQueue = (input: {
	readonly queueRequested: boolean;
	readonly isCloudSession: boolean;
}): boolean => input.queueRequested && !input.isCloudSession;

export const cloudWorkspaceNeedsResume = (
	workspace: Pick<CloudWorkspace, "state">,
): boolean =>
	workspace.state === "paused" ||
	workspace.state === "failed" ||
	workspace.state === "resuming";

export const shouldRetryCloudWorkspaceAttachment = (
	input: Pick<CloudWorkspace, "state" | "desiredState"> & {
		readonly resumeAttempts: number;
	},
): boolean =>
	input.state === "failed" &&
	input.desiredState === "ready" &&
	input.resumeAttempts < 2;

export const repositoryIdentityForOrigin = (
	origin: GitOriginInfo | null | undefined,
): string | null =>
	origin === null || origin === undefined
		? null
		: `${origin.host.toLowerCase()}/${origin.owner.toLowerCase()}/${origin.repo.toLowerCase()}`;

const sessionStatus = (summary: CloudChatSummary): Session["status"] =>
	summary.state === "failed" ? "error" : "idle";

const seedFor = (
	summary: CloudChatSummary,
	projectId: FolderId,
	firstMessage?: string,
) => {
	const now = new Date(summary.createdAt);
	const sessionId = SessionId.make(summary.initialSessionId);
	const chat = Chat.make({
		id: summary.chatId,
		projectId,
		worktreeId: null,
		title: summary.title,
		titleProvenance: "manual",
		activeSessionId: sessionId,
		originSessionId: null,
		archivedAt: null,
		lastMessageAt:
			summary.lastMessageAt === null
				? firstMessage === undefined
					? null
					: now
				: new Date(summary.lastMessageAt),
		lastReadAt: now,
		createdAt: now,
		updatedAt: new Date(summary.updatedAt),
	});
	const session = Session.make({
		id: sessionId,
		projectId,
		title: summary.title,
		titleProvenance: "manual",
		providerId: summary.agent,
		model: summary.model,
		status: sessionStatus(summary),
		archivedAt: null,
		cursor: null,
		resumeStrategy: "none",
		runtimeMode: "approval-required",
		worktreeId: null,
		chatId: summary.chatId,
		forkedFromSessionId: null,
		forkedFromMessageId: null,
		permissionMode: "default",
		toolSearch: false,
		createdAt: now,
		updatedAt: new Date(summary.updatedAt),
	});
	const initialMessage =
		firstMessage === undefined || firstMessage.trim().length === 0
			? null
			: Message.make({
					id: MessageId.make(`cloud-initial:${summary.workspaceId}`),
					sessionId,
					role: "user",
					content: { _tag: "user", text: firstMessage },
					createdAt: now,
				});
	return { chat, session, initialMessage };
};

export const messagesFromHistory = (
	history: CloudChatHistory,
	firstMessageCreatedAt = 0,
): ReadonlyArray<Message> => {
	const eventMessageRevisions = history.events.flatMap((row) => {
		if (row.type !== "MessagePersisted") return [];
		try {
			const event = JSON.parse(row.payloadJson) as Record<string, unknown>;
			if (
				typeof event.messageId !== "string" ||
				typeof event.role !== "string" ||
				typeof event.contentJson !== "string" ||
				typeof event.createdAt !== "number"
			)
				return [];
			return [
				Message.make({
					id: MessageId.make(event.messageId),
					sessionId: SessionId.make(history.initialSessionId),
					role: event.role as Message["role"],
					content: JSON.parse(event.contentJson) as Message["content"],
					createdAt: new Date(event.createdAt),
				}),
			];
		} catch {
			return [];
		}
	});
	const latestEventMessageById = new Map<MessageId, Message>();
	for (const message of eventMessageRevisions)
		latestEventMessageById.set(message.id, message);
	const eventMessages = [...latestEventMessageById.values()].sort(
		(left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
	);
	const firstPersistedUserMessage = eventMessages.find(
		(message) => message.role === "user",
	);
	const firstMessageAlreadyPersisted =
		history.firstMessage !== undefined &&
		firstPersistedUserMessage?.content._tag === "user" &&
		firstPersistedUserMessage.content.text === history.firstMessage;
	const durableFirstMessage =
		history.firstMessage === undefined ||
		history.firstMessage.trim().length === 0 ||
		firstMessageAlreadyPersisted
			? []
			: [
					Message.make({
						id: MessageId.make(`cloud-initial:${history.workspaceId}`),
						sessionId: SessionId.make(history.initialSessionId),
						role: "user",
						content: { _tag: "user", text: history.firstMessage },
						createdAt: new Date(firstMessageCreatedAt),
					}),
				];
	return [
		...durableFirstMessage,
		...eventMessages,
		...history.queuedMessages.map((queued) =>
			Message.make({
				id: queued.clientMessageId,
				sessionId: SessionId.make(history.initialSessionId),
				role: "user",
				content:
					queued.input.attachments.length > 0 ||
					queued.input.fileRefs.length > 0 ||
					queued.input.skillRefs.length > 0 ||
					(queued.input.annotations?.length ?? 0) > 0
						? {
								_tag: "user_rich",
								...queued.input,
								annotations: queued.input.annotations ?? [],
								goal: queued.asGoal,
							}
						: { _tag: "user", text: queued.input.text, goal: queued.asGoal },
				createdAt: new Date(queued.createdAt),
			}),
		),
	].filter(
		(message, index, all) =>
			all.findIndex((candidate) => candidate.id === message.id) === index,
	);
};

const applyCloudHistory = (
	summary: CloudChatSummary,
	projectId: FolderId,
	history: CloudChatHistory,
): ReadonlyArray<Message> => {
	const mergedHistory = mergeCloudChatHistory(
		histories.get(summary.workspaceId) ?? null,
		history,
	);
	histories.set(summary.workspaceId, mergedHistory);
	const projected = messagesFromHistory(mergedHistory, summary.createdAt);
	useMessagesStore.setState((state) => ({
		messagesBySession: {
			...state.messagesBySession,
			[summary.initialSessionId]: mergeCloudChatMessages(
				state.messagesBySession[summary.initialSessionId] ?? [],
				projected,
			),
		},
	}));
	const sessionId = SessionId.make(summary.initialSessionId);
	const currentRuntimeState = effectiveSessionRuntimeState(
		useSessionRuntimeStore.getState().bySession[sessionId],
	);
	if (
		shouldAttachCloudChatWithPendingCommands(history) &&
		!isSessionRuntimeBusy(currentRuntimeState)
	)
		useSessionRuntimeStore.getState().beginOptimisticTurn(sessionId);

	// Apply only the newly fetched status events, in sequence. Replaying the
	// merged history on every poll can regress a live turn through old states.
	for (const statusEvent of history.events
		.filter((event) => event.type === "SessionStatusSet")
		.sort((left, right) => left.sequence - right.sequence)) {
		try {
			const payload = JSON.parse(statusEvent.payloadJson) as {
				readonly status?: Session["status"];
			};
			if (payload.status !== undefined) {
				useSessionsStore.getState().setSessionStatus(sessionId, payload.status);
				useSessionRuntimeStore
					.getState()
					.observeSummary(sessionId, payload.status);
			}
		} catch {
			// Ignore malformed runtime events; message projection remains available.
		}
	}
	const latestMessageAt = projected.reduce(
		(latest, message) => Math.max(latest, message.createdAt.getTime()),
		summary.lastMessageAt ?? summary.createdAt,
	);
	useCloudChatsStore.setState((state) => ({
		summaries: mergeCloudChatSummaries(state.summaries, [
			{ ...summary, lastMessageAt: latestMessageAt },
		]),
	}));
	persistCloudChatSnapshot(summary, projectId);
	return projected;
};

const cloudHistoryHasChanges = (
	current: CloudChatHistory | undefined,
	incoming: CloudChatHistory,
): boolean => {
	if (current === undefined || incoming.cursor > current.cursor) return true;
	if (incoming.commandState !== current.commandState) return true;
	const currentQueue = new Map(
		current.queuedMessages.map((message) => [
			message.clientMessageId,
			message.state,
		]),
	);
	return incoming.queuedMessages.some(
		(message) => currentQueue.get(message.clientMessageId) !== message.state,
	);
};

const startCloudHistoryPump = (
	summary: CloudChatSummary,
	projectId: FolderId,
): void => {
	if (historyPumps.has(summary.workspaceId)) return;
	const pump = (async () => {
		await runCloudHistoryPump({
			initialCursor: histories.get(summary.workspaceId)?.cursor ?? 0,
			isActive: () =>
				useChatsStore.getState().selectedChatId === summary.chatId,
			fetchAfter: async (after) => {
				const control = await getControlPlaneRpcClient();
				return Effect.runPromise(
					control["cloud.chats.history"]({
						workspaceId: summary.workspaceId,
						after,
					}),
				);
			},
			apply: (history) => {
				if (
					!cloudHistoryHasChanges(histories.get(summary.workspaceId), history)
				)
					return;
				const latest = cloudSummaryForChat(summary.chatId) ?? summary;
				applyCloudHistory(latest, projectId, history);
			},
		});
	})().finally(() => historyPumps.delete(summary.workspaceId));
	historyPumps.set(summary.workspaceId, pump);
};

export const stageCloudChat = (
	summary: CloudChatSummary,
	projectId: FolderId,
	firstMessage?: string,
): void => {
	const current = cloudSummaryForChat(summary.chatId);
	if (
		current !== null &&
		(current.revision > summary.revision ||
			(current.revision === summary.revision &&
				current.updatedAt > summary.updatedAt))
	)
		return;
	const attachmentState =
		useCloudExecutionStore.getState().stateByWorkspace[summary.workspaceId] ??
		"detached";
	if (
		(summary.state === "paused" || summary.state === "archived") &&
		attachmentState !== "attaching"
	)
		setCloudAttachmentState(summary.workspaceId, "detached");
	registerCloudChat(summary, projectId);
	useCloudChatsStore.setState((state) => ({
		summaries: mergeCloudChatSummaries(state.summaries, [summary]),
	}));
	const seed = seedFor(summary, projectId, firstMessage);
	// Cloud chat/session creation is already durable before this projection is
	// staged. Release any stale local creation barrier immediately so live
	// timeline hydration can attach instead of returning early forever.
	acknowledgeTimelineSessionCreated(seed.session.id);
	markQueueHydrated(seed.session.id);
	useChatsStore.setState((state) => ({
		chatsByProject: {
			...state.chatsByProject,
			[projectId]: [
				(() => {
					const existing = (state.chatsByProject[projectId] ?? []).find(
						(chat) => chat.id === seed.chat.id,
					);
					return existing === undefined
						? seed.chat
						: Chat.make({
								...existing,
								title: summary.title,
								titleProvenance: "manual",
								archivedAt:
									summary.archivedAt === undefined
										? null
										: new Date(summary.archivedAt),
								lastMessageAt:
									summary.lastMessageAt === null
										? existing.lastMessageAt
										: new Date(summary.lastMessageAt),
								updatedAt: existing.updatedAt,
							});
				})(),
				...(state.chatsByProject[projectId] ?? []).filter(
					(chat) => chat.id !== seed.chat.id,
				),
			],
		},
		error: null,
	}));
	useSessionsStore.setState((state) => ({
		sessionsByProject: {
			...state.sessionsByProject,
			[projectId]: [
				(() => {
					const existing = (state.sessionsByProject[projectId] ?? []).find(
						(session) => session.id === seed.session.id,
					);
					return existing === undefined
						? seed.session
						: Session.make({
								...existing,
								title: summary.title,
								titleProvenance: "manual",
								status: summary.state === "failed" ? "error" : existing.status,
								updatedAt: existing.updatedAt,
							});
				})(),
				...(state.sessionsByProject[projectId] ?? []).filter(
					(session) => session.id !== seed.session.id,
				),
			],
		},
	}));
	if (
		seed.initialMessage !== null &&
		(useMessagesStore.getState().messagesBySession[seed.session.id]?.length ??
			0) === 0
	)
		useMessagesStore.setState((state) => ({
			messagesBySession: {
				...state.messagesBySession,
				[seed.session.id]: [seed.initialMessage as Message],
			},
		}));
	if (summary.state === "archived") {
		const chat = useChatsStore
			.getState()
			.chatsByProject[projectId]?.find(
				(candidate) => candidate.id === seed.chat.id,
			);
		const session = useSessionsStore
			.getState()
			.sessionsByProject[projectId]?.find(
				(candidate) => candidate.id === seed.session.id,
			);
		if (chat !== undefined && session !== undefined)
			useArchivePreviewStore
				.getState()
				.upsertCloudChat(
					chat,
					session,
					useMessagesStore.getState().messagesBySession[session.id] ?? [],
				);
	}
};

export const openCloudChat = (
	summary: CloudChatSummary,
	projectId: FolderId,
): Promise<void> => {
	const existing = opening.get(summary.workspaceId);
	if (existing !== undefined) return existing;
	const operation = (async () => {
		stageCloudChat(summary, projectId);
		useChatsStore.getState().select(summary.chatId);
		// Reading a paused chat stays offline, but an already-running workspace
		// should attach immediately so its live answer does not require a reload.
		if (shouldAttachCloudChatOnOpen(summary))
			void ensureCloudWorkspaceAttached(summary).catch(() => {});
		const snapshot = await cloudChatSnapshotStore
			?.load(summary.workspaceId)
			.catch(() => null);
		const cached = snapshot?.history ?? null;
		if (snapshot !== null && snapshot !== undefined) {
			const cachedSummary =
				snapshot.summary.revision > summary.revision
					? snapshot.summary
					: summary;
			stageCloudChat(cachedSummary, projectId, snapshot.history.firstMessage);
			histories.set(summary.workspaceId, snapshot.history);
			useMessagesStore.setState((state) => ({
				messagesBySession: {
					...state.messagesBySession,
					[summary.initialSessionId]: mergeCloudChatMessages(
						state.messagesBySession[summary.initialSessionId] ?? [],
						snapshot.messages,
					),
				},
			}));
			applyCloudHistory(cachedSummary, projectId, snapshot.history);
		}
		useCloudChatsStore.setState((state) => ({
			historyLoadingByChat: {
				...state.historyLoadingByChat,
				[summary.chatId]: cached === null,
			},
		}));
		try {
			const control = await getControlPlaneRpcClient();
			try {
				const history = await Effect.runPromise(
					control["cloud.chats.history"]({
						workspaceId: summary.workspaceId,
						...(cached === null ? {} : { after: cached.cursor }),
					}),
				);
				applyCloudHistory(summary, projectId, history);
			} catch (cause) {
				if (cached === null)
					useCloudChatsStore.setState({ error: formatError(cause) });
			}
		} finally {
			useCloudChatsStore.setState((state) => ({
				historyLoadingByChat: {
					...state.historyLoadingByChat,
					[summary.chatId]: false,
				},
			}));
		}
		// Central history has no runtime queue stream to hydrate. Release the
		// ordinary composer immediately so a paused chat remains fully readable
		// and the next message can be durably queued without waking compute first.
		markQueueHydrated(SessionId.make(summary.initialSessionId));
		startCloudHistoryPump(summary, projectId);
	})().finally(() => opening.delete(summary.workspaceId));
	opening.set(summary.workspaceId, operation);
	return operation;
};

/** Attach execution only for an explicit live action. Viewing history never calls this. */
export const ensureCloudWorkspaceAttached = (
	summary: CloudChatSummary,
): Promise<void> => {
	const attachmentState =
		useCloudExecutionStore.getState().stateByWorkspace[summary.workspaceId];
	if (
		canReuseCloudWorkspaceAttachment({
			summary,
			attachmentState,
			hasExecutionTarget: cloudExecutionTarget(summary.workspaceId) !== null,
		})
	)
		// Reuse the workspace connection, but retain/restart this chat's stream if
		// the view was previously closed long enough for its subscriber to evict.
		return attachCloudTranscriptLive(summary);
	const existing = attaching.get(summary.workspaceId);
	if (existing !== undefined) return existing;
	const operation = (async () => {
		const projectId = localProjectForCloudChat(summary.chatId);
		if (projectId !== null) startCloudHistoryPump(summary, projectId);
		setCloudAttachmentState(summary.workspaceId, "attaching");
		const control = await getControlPlaneRpcClient();
		const discovered = await Effect.runPromise(
			control["cloud.workspaces.get"]({ workspaceId: summary.workspaceId }),
		);
		let current = refreshSummaryFromWorkspace(summary, discovered);
		updateSummary(current);
		let resumeAttempts = 0;
		const resumeWorkspace = async (): Promise<void> => {
			const resumed = await Effect.runPromise(
				control["cloud.workspaces.resume"]({
					workspaceId: summary.workspaceId,
				}),
			);
			resumeAttempts += 1;
			current = refreshSummaryFromWorkspace(current, resumed);
			updateSummary(current);
		};
		if (cloudWorkspaceNeedsResume(discovered)) {
			await resumeWorkspace();
		}
		const readinessDeadline = Date.now() + 5 * 60 * 1_000;
		while (
			(current.state !== "ready" || current.runtimeState !== "online") &&
			Date.now() < readinessDeadline
		) {
			const workspace = await Effect.runPromise(
				control["cloud.workspaces.get"]({ workspaceId: summary.workspaceId }),
			);
			current = refreshSummaryFromWorkspace(current, workspace);
			updateSummary(current);
			if (current.state === "ready" && current.runtimeState === "online") break;
			if (
				shouldRetryCloudWorkspaceAttachment({
					state: current.state,
					desiredState: current.desiredState,
					resumeAttempts,
				})
			) {
				await resumeWorkspace();
				continue;
			}
			if (current.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		if (current.state === "failed")
			throw new Error(`Cloud startup failed during ${current.statusCode}.`);
		if (current.state !== "ready" || current.runtimeState !== "online")
			throw new Error(
				`Cloud startup is still waiting during ${current.statusCode}.`,
			);
		const connectionForWorkspace = () =>
			Effect.runPromise(
				control["cloud.workspaces.connect"]({
					workspaceId: summary.workspaceId,
				}),
			);
		const connection = await connectionForWorkspace();
		registerCloudWorkspace(
			summary.workspaceId,
			connection,
			connectionForWorkspace,
		);
		const client = await getRpcClient(summary.workspaceId);
		const folders = await Effect.runPromise(client["workspace.list"]({}));
		const folder =
			folders.find((candidate) => candidate.path === "/home/zuse/workspace") ??
			(await Effect.runPromise(
				client["workspace.add"]({ path: "/home/zuse/workspace" }),
			));
		registerCloudExecutionTarget(summary.workspaceId, {
			workspaceId: summary.workspaceId,
			projectId: summary.projectId,
			folderId: folder.id,
			rootPath: folder.path,
		});
		await attachCloudTranscriptLive(summary);
		setCloudAttachmentState(summary.workspaceId, "ready");
	})()
		.catch((cause) => {
			setCloudAttachmentState(summary.workspaceId, "failed");
			throw cause;
		})
		.finally(() => attaching.delete(summary.workspaceId));
	attaching.set(summary.workspaceId, operation);
	return operation;
};

export { cloudSummaryForChat, localProjectForCloudChat };

export const summaryFromLaunch = (input: {
	readonly workspace: CloudWorkspace;
	readonly repositoryIdentity: string;
	readonly repositoryDisplayName: string;
	readonly title: string;
	readonly agent: ProviderId;
	readonly model: string;
}): CloudChatSummary => ({
	workspaceId: input.workspace.workspaceId,
	projectId: input.workspace.projectId,
	repositoryIdentity: input.repositoryIdentity,
	repositoryDisplayName: input.repositoryDisplayName,
	chatId: input.workspace.chatId,
	initialSessionId: input.workspace.initialSessionId,
	title: input.title,
	branch: input.workspace.branch,
	providerId: input.workspace.providerId,
	agent: input.agent,
	model: input.model,
	state: input.workspace.state,
	runtimeState: input.workspace.runtimeState,
	statusCode: input.workspace.statusCode,
	startupPhase: input.workspace.startupPhase,
	desiredState: input.workspace.desiredState,
	revision: input.workspace.revision,
	unread: false,
	lastMessageAt: input.workspace.createdAt,
	createdAt: input.workspace.createdAt,
	updatedAt: input.workspace.updatedAt,
});

export const useCloudChatsStore = create<CloudChatsState>((set) => ({
	summaries: [],
	historyLoadingByChat: {},
	loading: false,
	error: null,
	hydrate: async () => {
		if (hydration !== null) return hydration;
		hydration = (async () => {
			set({ loading: true, error: null });
			try {
				const snapshots =
					(await cloudChatSnapshotStore?.list().catch(() => [])) ?? [];
				for (const snapshot of snapshots) {
					histories.set(snapshot.workspaceId, snapshot.history);
					stageCloudChat(
						snapshot.summary,
						snapshot.projectId,
						snapshot.history.firstMessage,
					);
					useMessagesStore.setState((state) => ({
						messagesBySession: {
							...state.messagesBySession,
							[snapshot.summary.initialSessionId]: mergeCloudChatMessages(
								state.messagesBySession[snapshot.summary.initialSessionId] ??
									[],
								snapshot.messages,
							),
						},
					}));
				}
				set((state) => ({
					summaries: mergeCloudChatSummaries(
						state.summaries,
						snapshots.map((snapshot) => snapshot.summary),
					),
				}));
				const client = await getControlPlaneRpcClient();
				const result = await Effect.runPromise(
					client["cloud.chats.list"]({ scope: "all" }),
				);
				for (const summary of result.chats) {
					registerCloudChat(summary);
					const projectId = localProjectForCloudChat(summary.chatId);
					if (projectId !== null) ensureCloudChatProjected(summary, projectId);
				}
				set((state) => ({
					summaries: mergeCloudChatSummaries(state.summaries, result.chats),
					loading: false,
				}));
			} catch (cause) {
				set({ error: formatError(cause), loading: false });
			}
		})().finally(() => {
			hydration = null;
		});
		return hydration;
	},
	archive: async (summary) => {
		const client = await getControlPlaneRpcClient();
		const workspace = await Effect.runPromise(
			client["cloud.workspaces.archive"]({
				workspaceId: summary.workspaceId,
			}),
		);
		updateSummary(refreshSummaryFromWorkspace(summary, workspace));
	},
}));

useMessagesStore.subscribe((state, previous) => {
	for (const summary of useCloudChatsStore.getState().summaries) {
		if (
			state.messagesBySession[summary.initialSessionId] ===
			previous.messagesBySession[summary.initialSessionId]
		)
			continue;
		const projectId = localProjectForCloudChat(summary.chatId);
		if (projectId !== null) persistCloudChatSnapshot(summary, projectId);
	}
});
