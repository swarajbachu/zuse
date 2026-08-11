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
} from "../lib/rpc-client.ts";
import { switchToCloudWorkspace } from "../lib/switch-environment.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { useChatsStore } from "./chats.ts";
import {
	cloudSummaryForChat,
	localProjectForCloudChat,
	registerCloudChat,
} from "./cloud-chat-registry.ts";
import {
	acknowledgeTimelineSessionCreated,
	deferTimelineUntilSessionCreated,
	useMessagesStore,
} from "./messages.ts";
import { markQueueHydrated } from "./queue-hydration.ts";
import { useSessionsStore } from "./sessions.ts";
import { useSkillsStore } from "./skills.ts";
import { useTerminalsStore } from "./terminals.ts";
import { useUiStore } from "./ui.ts";

type CloudChatsState = {
	readonly summaries: ReadonlyArray<CloudChatSummary>;
	readonly historyLoadingByChat: Readonly<Record<string, boolean>>;
	readonly loading: boolean;
	readonly error: string | null;
	readonly hydrate: () => Promise<void>;
	readonly archive: (summary: CloudChatSummary) => Promise<void>;
};

const opening = new Map<string, Promise<void>>();
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
	updatedAt: workspace.updatedAt,
});

const updateSummary = (summary: CloudChatSummary): void => {
	registerCloudChat(summary);
	useCloudChatsStore.setState((state) => ({
		summaries: state.summaries.map((row) =>
			row.chatId === summary.chatId ? summary : row,
		),
	}));
};

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
		titleProvenance: "pending",
		activeSessionId: sessionId,
		originSessionId: null,
		archivedAt: null,
		lastMessageAt: firstMessage === undefined ? null : now,
		lastReadAt: now,
		createdAt: now,
		updatedAt: new Date(summary.updatedAt),
	});
	const session = Session.make({
		id: sessionId,
		projectId,
		title: summary.title,
		titleProvenance: "pending",
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
			[summary.initialSessionId]: projected,
		},
	}));
	return projected;
};

export const stageCloudChat = (
	summary: CloudChatSummary,
	projectId: FolderId,
	firstMessage?: string,
): void => {
	registerCloudChat(summary, projectId);
	useCloudChatsStore.setState((state) => ({
		summaries: [
			summary,
			...state.summaries.filter((row) => row.chatId !== summary.chatId),
		],
	}));
	const seed = seedFor(summary, projectId, firstMessage);
	deferTimelineUntilSessionCreated(seed.session.id);
	useChatsStore.setState((state) => ({
		chatsByProject: {
			...state.chatsByProject,
			[projectId]: [
				seed.chat,
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
				seed.session,
				...(state.sessionsByProject[projectId] ?? []).filter(
					(session) => session.id !== seed.session.id,
				),
			],
		},
	}));
	if (seed.initialMessage !== null)
		useMessagesStore.setState((state) => ({
			messagesBySession: {
				...state.messagesBySession,
				[seed.session.id]: [seed.initialMessage as Message],
			},
		}));
};

export const openCloudChat = (
	summary: CloudChatSummary,
	projectId: FolderId,
	options?: { readonly activate?: boolean },
): Promise<void> => {
	const activate = options?.activate === true;
	const operationKey = `${summary.workspaceId}:${activate ? "activate" : "view"}`;
	const existing = opening.get(operationKey);
	if (existing !== undefined) return existing;
	const operation = (async () => {
		stageCloudChat(summary, projectId);
		markQueueHydrated(SessionId.make(summary.initialSessionId));
		useChatsStore.getState().select(summary.chatId);
		const cached = readCachedHistory(summary.workspaceId);
		let projected =
			cached === null ? [] : applyCloudHistory(summary, projectId, cached);
		useCloudChatsStore.setState((state) => ({
			historyLoadingByChat: {
				...state.historyLoadingByChat,
				[summary.chatId]: cached === null,
			},
		}));
		let control: Awaited<ReturnType<typeof getControlPlaneRpcClient>>;
		let history: CloudChatHistory;
		try {
			control = await getControlPlaneRpcClient();
			try {
				history = await Effect.runPromise(
					control["cloud.chats.history"]({ workspaceId: summary.workspaceId }),
				);
			} catch (cause) {
				if (cached === null) throw cause;
				history = cached;
			}
			writeCachedHistory(history);
			projected = [...applyCloudHistory(summary, projectId, history)];
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
		const alreadyLive =
			summary.state === "ready" && summary.runtimeState === "online";
		if (!activate && !alreadyLive) return;
		let current = summary;
		if (
			activate &&
			(summary.state === "paused" || summary.state === "failed")
		) {
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
		const liveSeed = seedFor(current, folder.id, history.firstMessage);
		await switchToCloudWorkspace({
			workspaceId: summary.workspaceId,
			folder,
			chatId: summary.chatId,
			seed: {
				chat: liveSeed.chat,
				initialSession: liveSeed.session,
				initialMessage: projected[0] ?? liveSeed.initialMessage,
			},
		});
		acknowledgeTimelineSessionCreated(liveSeed.session.id);
		await useMessagesStore
			.getState()
			.hydrate(liveSeed.session.id, { live: true });
		void useSkillsStore.getState().hydrate(liveSeed.session.id);
	})().finally(() => opening.delete(operationKey));
	opening.set(operationKey, operation);
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
	unread: false,
	createdAt: input.workspace.createdAt,
	updatedAt: input.workspace.updatedAt,
});

export const useCloudChatsStore = create<CloudChatsState>((set) => ({
	summaries: [],
	historyLoadingByChat: {},
	loading: false,
	error: null,
	hydrate: async () => {
		set({ loading: true, error: null });
		try {
			const client = await getControlPlaneRpcClient();
			const result = await Effect.runPromise(client["cloud.chats.list"]({}));
			for (const summary of result.chats) registerCloudChat(summary);
			set({ summaries: result.chats, loading: false });
		} catch (cause) {
			set({ error: formatError(cause), loading: false });
		}
	},
	archive: async (summary) => {
		const client = await getControlPlaneRpcClient();
		await Effect.runPromise(
			client["cloud.workspaces.archive"]({
				workspaceId: summary.workspaceId,
			}),
		);
		const projectId = localProjectForCloudChat(summary.chatId);
		if (useChatsStore.getState().selectedChatId === summary.chatId)
			useChatsStore.getState().select(null);
		set((state) => ({
			summaries: state.summaries.filter(
				(candidate) => candidate.chatId !== summary.chatId,
			),
		}));
		if (projectId !== null) {
			useChatsStore.setState((state) => ({
				chatsByProject: {
					...state.chatsByProject,
					[projectId]: (state.chatsByProject[projectId] ?? []).filter(
						(chat) => chat.id !== summary.chatId,
					),
				},
			}));
			useSessionsStore.setState((state) => ({
				sessionsByProject: {
					...state.sessionsByProject,
					[projectId]: (state.sessionsByProject[projectId] ?? []).filter(
						(session) => session.chatId !== summary.chatId,
					),
				},
			}));
		}
		useTerminalsStore.getState().disposeChat(summary.chatId);
		useUiStore.getState().clearChatPanels(summary.chatId);
	},
}));
