import {
	Chat,
	type CloudChatSummary,
	type CloudWorkspace,
	EnvironmentId,
	type FolderId,
	type GitOriginInfo,
	type ProviderId,
	Session,
	type SessionId,
} from "@zuse/contracts";
import { Effect } from "effect";
import {
	cloudWorkspaceStartupError,
	isCloudWorkspaceReady,
	waitForCloudWorkspaceReady,
} from "../lib/cloud-workspace-lifecycle.ts";
import { overlayActiveEnvironmentShell } from "../lib/environment-entities.ts";
import { formatError } from "../lib/format-error.ts";
import {
	getControlPlaneRpcClient,
	registerCloudWorkspace,
} from "../lib/rpc-client.ts";
import { registerEnvironmentWake } from "../lib/session-timeline-client-bus.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { useChatsStore } from "../store/chats.ts";
import { useSessionsStore } from "../store/sessions.ts";
import {
	cloudSummaryForChat,
	cloudSummaryForEnvironment,
	cloudSummaryForSession,
	compareCloudChatSummaryVersion,
	localProjectForCloudChat,
	localProjectForCloudEnvironment,
	reconcileCloudChatCatalog,
	registerCloudChat,
	registerCloudChatCatalogRefresh,
	useCloudChatCatalogStore,
} from "./cloud-workspace-catalog.ts";

type CloudChatsState = {
	readonly loading: boolean;
	readonly error: string | null;
	readonly hydrate: () => Promise<void>;
	readonly archive: (summary: CloudChatSummary) => Promise<void>;
};

const opening = new Map<string, Promise<void>>();
const attaching = new Map<string, Promise<void>>();
const registeredWakeByEnvironment = new Map<string, CloudChatSummary>();
let hydration: Promise<void> | null = null;

/**
 * Cloud wakeup is an environment capability. Register it when catalog metadata
 * arrives so every ClientBus resource shares one attachment path instead of
 * teaching feature stores how to resume a workspace.
 */
const registerCloudEnvironmentResolver = (summary: CloudChatSummary): void => {
	const previous = registeredWakeByEnvironment.get(summary.workspaceId);
	if (previous !== undefined) {
		if (compareCloudChatSummaryVersion(summary, previous) < 0) return;
		registeredWakeByEnvironment.set(summary.workspaceId, summary);
		return;
	}
	registeredWakeByEnvironment.set(summary.workspaceId, summary);
	let rootPrepared = false;
	registerEnvironmentWake(
		EnvironmentId.make(summary.workspaceId),
		async () => {
			const fallback =
				registeredWakeByEnvironment.get(summary.workspaceId) ?? summary;
			const current =
				useCloudChatCatalogStore
					.getState()
					.summaries.find(
						(candidate) => candidate.workspaceId === summary.workspaceId,
					) ??
				cloudSummaryForChat(fallback.chatId) ??
				fallback;
			await ensureCloudWorkspaceEnvironment(current);
		},
		async (client) => {
			if (rootPrepared) return;
			const folders = await Effect.runPromise(client["workspace.list"]({}));
			if (
				folders.every((candidate) => candidate.path !== "/home/zuse/workspace")
			) {
				await Effect.runPromise(
					client["workspace.add"]({ path: "/home/zuse/workspace" }),
				);
			}
			rootPrepared = true;
		},
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
	const current = cloudSummaryForEnvironment(summary.workspaceId);
	if (current !== null && compareCloudChatSummaryVersion(summary, current) < 0)
		return;
	registerCloudChat(summary);
	const accepted = cloudSummaryForEnvironment(summary.workspaceId) ?? summary;
	registerCloudEnvironmentResolver(accepted);
	const projectId = localProjectForCloudEnvironment(summary.workspaceId);
	if (projectId !== null) stageCloudChat(accepted, projectId);
};

export const repositoryIdentityForOrigin = (
	origin: GitOriginInfo | null | undefined,
): string | null =>
	origin === null || origin === undefined
		? null
		: `${origin.host.toLowerCase()}/${origin.owner.toLowerCase()}/${origin.repo.toLowerCase()}`;

const sessionStatus = (summary: CloudChatSummary): Session["status"] =>
	summary.state === "failed" ? "error" : "idle";

/**
 * Relay catalog rows are placeholders only. The environment runtime timeline
 * replaces this shell as soon as the user retains the chat resource.
 */
export const stageCloudChat = (
	summary: CloudChatSummary,
	projectId: FolderId,
	_firstMessage?: string,
): void => {
	const previous = cloudSummaryForEnvironment(summary.workspaceId);
	if (
		previous !== null &&
		compareCloudChatSummaryVersion(summary, previous) < 0
	)
		return;
	registerCloudChat(summary, projectId);
	const accepted = cloudSummaryForEnvironment(summary.workspaceId) ?? summary;
	registerCloudEnvironmentResolver(accepted);
	const now = new Date(accepted.createdAt);
	const archivedAt =
		accepted.archivedAt === undefined ? null : new Date(accepted.archivedAt);
	const chat = Chat.make({
		id: accepted.chatId,
		projectId,
		worktreeId: null,
		title: accepted.title,
		titleProvenance: "manual",
		activeSessionId: accepted.initialSessionId,
		originSessionId: null,
		archivedAt,
		lastMessageAt:
			accepted.lastMessageAt === null ? null : new Date(accepted.lastMessageAt),
		lastReadAt: now,
		createdAt: now,
		updatedAt: new Date(accepted.updatedAt),
	});
	const session = Session.make({
		id: accepted.initialSessionId,
		projectId,
		title: accepted.title,
		titleProvenance: "manual",
		providerId: accepted.agent,
		model: accepted.model,
		status: sessionStatus(accepted),
		archivedAt: null,
		cursor: null,
		resumeStrategy: "none",
		runtimeMode: "approval-required",
		worktreeId: null,
		chatId: accepted.chatId,
		forkedFromSessionId: null,
		forkedFromMessageId: null,
		permissionMode: "default",
		toolSearch: false,
		createdAt: now,
		updatedAt: new Date(accepted.updatedAt),
	});
	overlayActiveEnvironmentShell((shell) => ({
		...shell,
		chatsByProject: {
			...shell.chatsByProject,
			[projectId]: [
				chat,
				...(shell.chatsByProject[projectId] ?? []).filter(
					(candidate) => candidate.id !== chat.id,
				),
			],
		},
		sessionsByProject: {
			...shell.sessionsByProject,
			[projectId]: [
				session,
				...(shell.sessionsByProject[projectId] ?? []).filter(
					(candidate) => candidate.id !== session.id,
				),
			],
		},
	}));
	useChatsStore.setState({ error: null });
};

export const openCloudChat = (
	summary: CloudChatSummary,
	projectId: FolderId,
): Promise<void> => {
	const existing = opening.get(summary.workspaceId);
	if (existing !== undefined) return existing;
	const operation = Promise.resolve().then(() => {
		stageCloudChat(summary, projectId);
		useChatsStore.getState().select(summary.chatId);
		// The timeline retain is cache-first. An already-running workspace can be
		// attached in the background; paused compute is woken only by a live action.
		if (summary.state === "ready" && summary.runtimeState === "online")
			void ensureCloudWorkspaceAttached(summary).catch(() => undefined);
	});
	const tracked = operation.finally(() => opening.delete(summary.workspaceId));
	opening.set(summary.workspaceId, tracked);
	return tracked;
};

const workspaceNeedsWake = (
	workspace: Pick<CloudWorkspace, "state">,
): boolean =>
	workspace.state === "paused" ||
	workspace.state === "failed" ||
	workspace.state === "resuming";

/** Cloud is an EnvironmentResolver capability, not a second message path. */
export const ensureCloudWorkspaceAttached = (
	summary: CloudChatSummary,
): Promise<void> => {
	const existing = attaching.get(summary.workspaceId);
	if (existing !== undefined) return existing;
	const operation = (async () => {
		const control = await getControlPlaneRpcClient();
		let workspace = await Effect.runPromise(
			control["cloud.workspaces.get"]({ workspaceId: summary.workspaceId }),
		);
		if (workspaceNeedsWake(workspace)) {
			workspace = await Effect.runPromise(
				control["cloud.workspaces.resume"]({
					workspaceId: summary.workspaceId,
				}),
			);
		}
		updateSummary(refreshSummaryFromWorkspace(summary, workspace));
		if (!isCloudWorkspaceReady(workspace)) {
			const error = cloudWorkspaceStartupError(workspace);
			if (error !== null) throw error;
			workspace = await waitForCloudWorkspaceReady(
				control["cloud.workspaces.watch"]({
					workspaceId: summary.workspaceId,
					afterRevision: workspace.revision,
				}),
				(next) => updateSummary(refreshSummaryFromWorkspace(summary, next)),
			);
		}
		const connectionForWorkspace = () =>
			Effect.runPromise(
				control["cloud.workspaces.connect"]({
					workspaceId: summary.workspaceId,
				}),
			);
		registerCloudWorkspace(
			summary.workspaceId,
			await connectionForWorkspace(),
			connectionForWorkspace,
		);
	})().finally(() => attaching.delete(summary.workspaceId));
	attaching.set(summary.workspaceId, operation);
	return operation;
};

export const ensureCloudWorkspaceEnvironment = (
	summary: CloudChatSummary,
): Promise<void> => ensureCloudWorkspaceAttached(summary);

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
	summaryRevision: 0,
	sessionHeadVersion: 0,
	unread: false,
	lastMessageAt: input.workspace.createdAt,
	createdAt: input.workspace.createdAt,
	updatedAt: input.workspace.updatedAt,
});

const removeDeletedCloudPlaceholders = (
	removed: ReadonlyArray<CloudChatSummary>,
): void => {
	if (removed.length === 0) return;
	const chatIds = new Set(removed.map((summary) => summary.chatId));
	const sessionIds = new Set(
		removed.map((summary) => summary.initialSessionId),
	);
	overlayActiveEnvironmentShell((shell) => ({
		...shell,
		chatsByProject: Object.fromEntries(
			Object.entries(shell.chatsByProject).map(([projectId, chats]) => [
				projectId,
				chats.filter((chat) => !chatIds.has(chat.id)),
			]),
		),
		sessionsByProject: Object.fromEntries(
			Object.entries(shell.sessionsByProject).map(([projectId, sessions]) => [
				projectId,
				sessions.filter((session) => !sessionIds.has(session.id)),
			]),
		),
	}));
	useChatsStore.setState((state) => ({
		selectedChatId:
			state.selectedChatId !== null && chatIds.has(state.selectedChatId)
				? null
				: state.selectedChatId,
		selectedChatByProject: Object.fromEntries(
			Object.entries(state.selectedChatByProject).map(([projectId, chatId]) => [
				projectId,
				chatId !== null && chatIds.has(chatId) ? null : chatId,
			]),
		),
	}));
	useSessionsStore.setState((state) => ({
		selectedSessionId:
			state.selectedSessionId !== null &&
			sessionIds.has(state.selectedSessionId)
				? null
				: state.selectedSessionId,
		selectedSessionByProject: Object.fromEntries(
			Object.entries(state.selectedSessionByProject).map(
				([projectId, sessionId]) => [
					projectId,
					sessionId !== null && sessionIds.has(sessionId) ? null : sessionId,
				],
			),
		),
	}));
};

export const useCloudChatsStore = create<CloudChatsState>((set) => ({
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
				removeDeletedCloudPlaceholders(reconcileCloudChatCatalog(result.chats));
				for (const summary of result.chats) {
					registerCloudChat(summary);
					const accepted =
						cloudSummaryForEnvironment(summary.workspaceId) ?? summary;
					registerCloudEnvironmentResolver(accepted);
					const projectId = localProjectForCloudEnvironment(
						summary.workspaceId,
					);
					if (projectId !== null) stageCloudChat(accepted, projectId);
				}
				set({ loading: false });
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

registerCloudChatCatalogRefresh(() => useCloudChatsStore.getState().hydrate());

export const useCloudChatSummaryForSession = (
	sessionId: SessionId | null,
): CloudChatSummary | null => {
	const registered =
		sessionId === null ? null : cloudSummaryForSession(sessionId);
	return useCloudChatCatalogStore((state) =>
		sessionId === null
			? null
			: (state.summaries.find(
					(summary) => summary.initialSessionId === sessionId,
				) ?? registered),
	);
};
