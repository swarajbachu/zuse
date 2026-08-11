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
import { Effect, Schema } from "effect";
import { formatError } from "../lib/format-error.ts";
import {
	getControlPlaneRpcClient,
	getRpcClient,
	registerCloudWorkspace,
	setDefaultRpcEnvironmentResolver,
} from "../lib/rpc-client.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { useArchivePreviewStore } from "./archive-preview.ts";
import { useChatsStore } from "./chats.ts";
import {
	cloudExecutionTarget,
	cloudSummaryForChat,
	localProjectForCloudChat,
	registerCloudChat,
	registerCloudExecutionTarget,
} from "./cloud-chat-registry.ts";
import {
	acknowledgeTimelineSessionCreated,
	useMessagesStore,
} from "./messages.ts";
import { markQueueHydrated } from "./queue-hydration.ts";
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
const historyCacheKey = (workspaceId: string): string =>
	`zuse.cloudChatHistory.${workspaceId}`;

const readCachedHistory = (workspaceId: string): CloudChatHistory | null => {
	if (typeof window === "undefined") return null;
	try {
		const value = window.localStorage.getItem(historyCacheKey(workspaceId));
		if (value === null) return null;
		const decoded = Schema.decodeUnknownOption(CloudChatHistory)(
			JSON.parse(value),
		);
		return decoded._tag === "Some" ? decoded.value : null;
	} catch {
		return null;
	}
};

const writeCachedHistory = (history: CloudChatHistory): void => {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(
			historyCacheKey(history.workspaceId),
			JSON.stringify(history),
		);
	} catch {
		// Central history remains authoritative when the local cache is full or
		// unavailable (for example in a restricted browser context).
	}
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
	registerCloudChat(summary);
	const projectId = localProjectForCloudChat(summary.chatId);
	if (projectId !== null) stageCloudChat(summary, projectId);
	useCloudChatsStore.setState((state) => ({
		summaries: mergeCloudChatSummaries(state.summaries, [summary]),
	}));
};

export const mergeCloudChatSummaries = (
	current: ReadonlyArray<CloudChatSummary>,
	incoming: ReadonlyArray<CloudChatSummary>,
): ReadonlyArray<CloudChatSummary> => {
	const byChat = new Map(current.map((summary) => [summary.chatId, summary]));
	for (const summary of incoming) {
		const previous = byChat.get(summary.chatId);
		if (previous === undefined || summary.revision >= previous.revision)
			byChat.set(summary.chatId, summary);
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

export const cloudWorkspaceNeedsResume = (
	workspace: Pick<CloudWorkspace, "state">,
): boolean =>
	workspace.state === "paused" ||
	workspace.state === "failed" ||
	workspace.state === "resuming";

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
	const eventMessages = history.events.flatMap((row) => {
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
	stageCloudChat(summary, projectId, history.firstMessage);
	const projected = messagesFromHistory(history, summary.createdAt);
	useMessagesStore.setState((state) => ({
		messagesBySession: {
			...state.messagesBySession,
			[summary.initialSessionId]: mergeCloudChatMessages(
				state.messagesBySession[summary.initialSessionId] ?? [],
				projected,
			),
		},
	}));
	return projected;
};

export const stageCloudChat = (
	summary: CloudChatSummary,
	projectId: FolderId,
	firstMessage?: string,
): void => {
	const current = cloudSummaryForChat(summary.chatId);
	if (current !== null && current.revision > summary.revision) return;
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
								updatedAt: new Date(summary.updatedAt),
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
								status: sessionStatus(summary),
								updatedAt: new Date(summary.updatedAt),
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
		const cached = readCachedHistory(summary.workspaceId);
		if (cached !== null) applyCloudHistory(summary, projectId, cached);
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
					control["cloud.chats.history"]({ workspaceId: summary.workspaceId }),
				);
				writeCachedHistory(history);
				applyCloudHistory(summary, projectId, history);
			} catch (cause) {
				if (cached === null) throw cause;
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
	})().finally(() => opening.delete(summary.workspaceId));
	opening.set(summary.workspaceId, operation);
	return operation;
};

/** Attach execution only for an explicit live action. Viewing history never calls this. */
export const ensureCloudWorkspaceAttached = (
	summary: CloudChatSummary,
): Promise<void> => {
	const existing = attaching.get(summary.workspaceId);
	if (existing !== undefined) return existing;
	const operation = (async () => {
		const control = await getControlPlaneRpcClient();
		const discovered = await Effect.runPromise(
			control["cloud.workspaces.get"]({ workspaceId: summary.workspaceId }),
		);
		let current = refreshSummaryFromWorkspace(summary, discovered);
		updateSummary(current);
		if (cloudWorkspaceNeedsResume(discovered)) {
			const resumed = await Effect.runPromise(
				control["cloud.workspaces.resume"]({
					workspaceId: summary.workspaceId,
				}),
			);
			current = refreshSummaryFromWorkspace(current, resumed);
			updateSummary(current);
		}
		const readinessDeadline = Date.now() + 5 * 60 * 1_000;
		while (
			(current.state !== "ready" || current.runtimeState !== "online") &&
			current.state !== "failed" &&
			Date.now() < readinessDeadline
		) {
			const workspace = await Effect.runPromise(
				control["cloud.workspaces.get"]({ workspaceId: summary.workspaceId }),
			);
			current = refreshSummaryFromWorkspace(current, workspace);
			updateSummary(current);
			if (current.state === "ready" && current.runtimeState === "online") break;
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
		await useMessagesStore
			.getState()
			.hydrate(SessionId.make(summary.initialSessionId), {
				live: true,
				environmentId: summary.workspaceId,
			});
	})().finally(() => attaching.delete(summary.workspaceId));
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
				const client = await getControlPlaneRpcClient();
				const result = await Effect.runPromise(
					client["cloud.chats.list"]({ scope: "all" }),
				);
				for (const summary of result.chats) {
					registerCloudChat(summary);
					const projectId = localProjectForCloudChat(summary.chatId);
					if (projectId !== null) stageCloudChat(summary, projectId);
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
