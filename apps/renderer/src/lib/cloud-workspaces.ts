import { cloudSessionPlaceholder } from "@zuse/client-runtime/cloud-catalog";
import {
	openCloudTranscriptCheckpoint,
	openCloudTranscriptPage,
} from "@zuse/client-runtime/cloud-transcript";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import type {
	ConnectionView,
	ResourceView,
} from "@zuse/client-runtime/resource-state";
import type { SessionTimelineProjection } from "@zuse/contracts";
import {
	Chat,
	type ChatId,
	type CloudChatSummary,
	type CloudWorkspace,
	EnvironmentId,
	type FolderId,
	type GitOriginInfo,
	Message,
	MessageId,
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
	refreshCloudWorkspaceConnectionWithRecovery,
	registerCloudWorkspace,
} from "../lib/rpc-client.ts";
import {
	sessionTimelineCache,
	timelineReadingPositionStore,
} from "../lib/session-timeline-cache.ts";
import {
	addOptimisticSessionMessage,
	completeOlderSessionMessages,
	getRendererClientBus,
	registerEnvironmentActivation,
	registerSessionTimelineCheckpointSynchronizer,
	registerSessionTimelineOlderPageSynchronizer,
	retryRendererEnvironmentConnection,
} from "../lib/session-timeline-client-bus.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { useChatsStore } from "../store/chats.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import {
	cloudSummaryActiveSessionId,
	cloudSummaryForChat,
	cloudSummaryForEnvironment,
	compareCloudChatSummaryVersion,
	findCloudSummaryForSelection,
	hydrateCloudChatCatalogPersistence,
	localProjectForCloudChat,
	localProjectForCloudEnvironment,
	optimisticallyArchiveCloudChat,
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
type CloudAttachment = {
	activation: "connect" | "wake";
	promise: Promise<void>;
};
const attaching = new Map<string, CloudAttachment>();
const registeredCloudEnvironments = new Map<string, CloudChatSummary>();
const rearmedClientByWorkspace = new Map<string, string>();
let hydration: Promise<void> | null = null;

/**
 * An authoritative ready runtime is a new recovery signal for a client whose
 * socket exhausted its retry ladder while compute was asleep. Include both
 * lifecycle revision and client generation so each real state change gets one
 * automatic attempt without turning a persistent outage into a retry storm.
 */
export const cloudConnectionRearmKey = (
	summary: CloudChatSummary,
	connection: ConnectionView,
): string | null =>
	summary.state === "ready" &&
	summary.runtimeState === "online" &&
	connection.phase === "failed"
		? `${summary.workspaceId}:${summary.revision}:${connection.generation}`
		: null;

export const rearmReadyCloudConnection = (
	summary: CloudChatSummary,
	connection: ConnectionView,
	attempts: Map<string, string>,
	retry: (environmentId: EnvironmentId) => void,
): boolean => {
	const key = cloudConnectionRearmKey(summary, connection);
	if (key === null || attempts.get(summary.workspaceId) === key) return false;
	attempts.set(summary.workspaceId, key);
	retry(EnvironmentId.make(summary.workspaceId));
	return true;
};

export const rearmRegisteredCloudConnection = (
	summary: CloudChatSummary,
): void => {
	const environmentId = EnvironmentId.make(summary.workspaceId);
	rearmReadyCloudConnection(
		summary,
		getRendererClientBus().connection(environmentId),
		rearmedClientByWorkspace,
		(retryEnvironmentId) =>
			queueMicrotask(() =>
				retryRendererEnvironmentConnection(retryEnvironmentId),
			),
	);
};

const trackCloudAttachment = (
	workspaceId: string,
	activation: CloudAttachment["activation"],
	operation: Promise<void>,
): Promise<void> => {
	let tracked: Promise<void>;
	tracked = operation.finally(() => {
		if (attaching.get(workspaceId)?.promise === tracked) {
			attaching.delete(workspaceId);
		}
	});
	attaching.set(workspaceId, { activation, promise: tracked });
	return tracked;
};

/**
 * Cloud wakeup is an environment capability. Register it when catalog metadata
 * arrives so every ClientBus resource shares one attachment path instead of
 * teaching feature stores how to resume a workspace.
 */
const registerCloudEnvironmentResolver = (summary: CloudChatSummary): void => {
	const previous = registeredCloudEnvironments.get(summary.workspaceId);
	if (previous !== undefined) {
		if (compareCloudChatSummaryVersion(summary, previous) < 0) return;
		registeredCloudEnvironments.set(summary.workspaceId, summary);
		rearmRegisteredCloudConnection(summary);
		return;
	}
	registeredCloudEnvironments.set(summary.workspaceId, summary);
	let rootPrepared = false;
	registerSessionTimelineCheckpointSynchronizer(
		EnvironmentId.make(summary.workspaceId),
		async (ref, current: ResourceView<SessionTimelineProjection>) => {
			const control = await getControlPlaneRpcClient();
			const result = await Effect.runPromise(
				control["cloud.transcript.get"]({
					workspaceId: summary.workspaceId,
					sessionId: ref.sessionId,
					// A local IndexedDB entry is only a rendering accelerator. API's
					// encrypted checkpoint is authoritative, so initial hydration requests
					// the full checkpoint even when the cache claims the same cursor.
					cursor:
						current.origin === "cache"
							? undefined
							: (current.cursor ?? undefined),
				}),
			);
			const checkpoint = result.checkpoint;
			if (checkpoint === null) return null;
			const payload = await openCloudTranscriptCheckpoint(ref, checkpoint);
			if (
				current.connection === "dormant" &&
				payload.projection.olderMessageSequence != null
			) {
				// Let ClientBus publish the recent checkpoint first, then complete its
				// canonical projection automatically from encrypted storage pages.
				setTimeout(() => {
					void completeOlderSessionMessages(ref).catch((cause) => {
						useCloudChatsStore.setState({ error: formatError(cause) });
					});
				}, 0);
			}
			return {
				data: payload.projection,
				cursor: payload.cursor,
				resetEpoch:
					current.cursor !== null &&
					current.cursor.epoch !== payload.cursor.epoch,
			};
		},
	);
	registerSessionTimelineOlderPageSynchronizer(
		EnvironmentId.make(summary.workspaceId),
		async (ref, cursor, beforeSequence) => {
			const control = await getControlPlaneRpcClient();
			const result = await Effect.runPromise(
				control["cloud.transcript.messages.page"]({
					workspaceId: summary.workspaceId,
					sessionId: ref.sessionId,
					cursor,
					beforeSequence,
				}),
			);
			const encrypted = result.page;
			if (encrypted === null) return null;
			return openCloudTranscriptPage(ref, cursor, beforeSequence, encrypted);
		},
	);
	registerEnvironmentActivation(
		EnvironmentId.make(summary.workspaceId),
		async (activation) => {
			const fallback =
				registeredCloudEnvironments.get(summary.workspaceId) ?? summary;
			const current =
				useCloudChatCatalogStore
					.getState()
					.summaries.find(
						(candidate) => candidate.workspaceId === summary.workspaceId,
					) ??
				cloudSummaryForChat(fallback.chatId) ??
				fallback;
			await ensureCloudWorkspaceEnvironment(current, activation);
		},
		async (client) => {
			if (rootPrepared) return;
			const folders = await Effect.runPromise(client["workspace.list"]({}));
			// The cloud runtime registers the selected checkout before API marks the
			// sandbox repository-ready. Never manufacture a second, placeholder root.
			rootPrepared = folders.length > 0;
		},
		"cloud-workspace",
	);
	rearmRegisteredCloudConnection(summary);
};

const refreshSummaryFromWorkspace = (
	summary: CloudChatSummary,
	workspace: CloudWorkspace,
): CloudChatSummary => ({
	...summary,
	codexAuthMode: workspace.codexAuthMode,
	providerAuthMode: workspace.providerAuthMode,
	state: workspace.state,
	runtimeState: workspace.runtimeState,
	statusCode: workspace.statusCode,
	failureDiagnostic: workspace.failureDiagnostic,
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

export { cloudSessionPlaceholder } from "@zuse/client-runtime/cloud-catalog";

/**
 * API catalog rows are placeholders only. The environment runtime timeline
 * replaces this shell as soon as the user retains the chat resource.
 */
export const stageCloudChat = (
	summary: CloudChatSummary,
	projectId: FolderId,
	legacyFirstMessage?: string,
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
	const activeSessionId = cloudSummaryActiveSessionId(accepted);
	const chat = Chat.make({
		id: accepted.chatId,
		projectId,
		worktreeId: null,
		title: accepted.title,
		titleProvenance: "manual",
		activeSessionId,
		originSessionId: null,
		archivedAt,
		lastMessageAt:
			accepted.lastMessageAt === null ? null : new Date(accepted.lastMessageAt),
		lastReadAt: now,
		createdAt: now,
		updatedAt: new Date(accepted.updatedAt),
	});
	const session =
		activeSessionId === null
			? null
			: cloudSessionPlaceholder(accepted, projectId, activeSessionId);
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
			[projectId]:
				session === null
					? (shell.sessionsByProject[projectId] ?? [])
					: [
							session,
							...(shell.sessionsByProject[projectId] ?? []).filter(
								(candidate) => candidate.id !== session.id,
							),
						],
		},
	}));
	// Compatibility only: an API that did not acknowledge mailbox-v1 still owns
	// the prompt in its encrypted launch intent. The stable ID is replaced by the
	// authoritative launch message rather than producing a duplicate.
	if (legacyFirstMessage !== undefined) {
		addOptimisticSessionMessage(
			{
				environmentId: EnvironmentId.make(accepted.workspaceId),
				sessionId: accepted.initialSessionId,
			} satisfies SessionRef,
			Message.make({
				id: MessageId.make(`launch:${accepted.workspaceId}:message`),
				sessionId: accepted.initialSessionId,
				role: "user",
				content: { _tag: "user", text: legacyFirstMessage, goal: false },
				createdAt: now,
			}),
		);
	}
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
		const activeSessionId = cloudSummaryActiveSessionId(summary);
		// Catalog selection must not depend on a paused runtime shell. Select the
		// durable ids now so the qualified timeline cache can hydrate immediately.
		useUiStore.getState().setActiveMainTab("chat");
		useChatsStore.setState((state) => ({
			selectedChatId: summary.chatId,
			selectedChatByProject: {
				...state.selectedChatByProject,
				[projectId]: summary.chatId,
			},
		}));
		useSessionsStore.setState((state) => ({
			selectedSessionId: activeSessionId,
			selectedSessionByProject: {
				...state.selectedSessionByProject,
				[projectId]: activeSessionId,
			},
		}));
		if (useWorkspaceStore.getState().selectedFolderId !== projectId) {
			void useWorkspaceStore.getState().select(projectId);
		}
		// The retained timeline hydrates cache first. EnvironmentRuntime then
		// prepares the gateway and attaches in one ordered background operation.
	});
	const tracked = operation.finally(() => opening.delete(summary.workspaceId));
	opening.set(summary.workspaceId, tracked);
	return tracked;
};

const workspaceNeedsWake = (
	workspace: Pick<CloudWorkspace, "state">,
): boolean => workspace.state === "paused" || workspace.state === "failed";

/** Cloud is an EnvironmentResolver capability, not a second message path. */
export const ensureCloudWorkspaceAttached = (
	summary: CloudChatSummary,
	activation: "connect" | "wake" = "wake",
): Promise<void> => {
	const existing = attaching.get(summary.workspaceId);
	if (existing !== undefined) {
		if (existing.activation === "wake" || activation === "connect") {
			return existing.promise;
		}
		// A live command can arrive while a passive transcript attachment is still
		// resolving. Wake is a stronger side effect: never let it inherit the
		// passive request's failure (for example when API has just paused compute).
		const escalated = existing.promise
			.catch(() => undefined)
			.then(() => attachCloudWorkspace(summary, "wake"));
		return trackCloudAttachment(summary.workspaceId, "wake", escalated);
	}
	return trackCloudAttachment(
		summary.workspaceId,
		activation,
		attachCloudWorkspace(summary, activation),
	);
};

const attachCloudWorkspace = async (
	summary: CloudChatSummary,
	activation: "connect" | "wake",
): Promise<void> => {
	const control = await getControlPlaneRpcClient();
	let workspace = await Effect.runPromise(
		control["cloud.workspaces.get"]({ workspaceId: summary.workspaceId }),
	);
	if (workspaceNeedsWake(workspace) && activation === "wake") {
		workspace = await Effect.runPromise(
			control["cloud.workspaces.resume"]({
				workspaceId: summary.workspaceId,
			}),
		);
	}
	updateSummary(refreshSummaryFromWorkspace(summary, workspace));
	if (activation === "connect" && !isCloudWorkspaceReady(workspace)) {
		throw new Error(
			workspace.state === "paused"
				? "Cloud workspace is paused."
				: "Cloud workspace is not currently available for passive attachment.",
		);
	}
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
		refreshCloudWorkspaceConnectionWithRecovery(
			summary.workspaceId,
			async (recoveryCommandId) => {
				let recovered = await Effect.runPromise(
					control["cloud.workspaces.resume"]({
						workspaceId: summary.workspaceId,
						recoverRuntime: true,
						commandId: recoveryCommandId,
					}),
				);
				updateSummary(refreshSummaryFromWorkspace(summary, recovered));
				if (!isCloudWorkspaceReady(recovered)) {
					const error = cloudWorkspaceStartupError(recovered);
					if (error !== null) throw error;
					recovered = await waitForCloudWorkspaceReady(
						control["cloud.workspaces.watch"]({
							workspaceId: summary.workspaceId,
							afterRevision: recovered.revision,
						}),
						(next) => updateSummary(refreshSummaryFromWorkspace(summary, next)),
					);
				}
			},
			() =>
				Effect.runPromise(
					control["cloud.workspaces.connect"]({
						workspaceId: summary.workspaceId,
					}),
				),
		);
	registerCloudWorkspace(
		summary.workspaceId,
		await connectionForWorkspace(),
		connectionForWorkspace,
	);
};

const ensureCloudWorkspaceEnvironment = (
	summary: CloudChatSummary,
	activation: "connect" | "wake",
): Promise<void> => ensureCloudWorkspaceAttached(summary, activation);

export { summaryFromLaunch } from "@zuse/client-runtime/cloud-catalog";
export { cloudSummaryForChat, localProjectForCloudChat };

const removeDeletedCloudPlaceholders = (
	removed: ReadonlyArray<CloudChatSummary>,
): void => {
	if (removed.length === 0) return;
	for (const summary of removed) {
		const ref = {
			environmentId: EnvironmentId.make(summary.workspaceId),
			sessionId: summary.initialSessionId,
		};
		void Promise.all([
			sessionTimelineCache?.remove(ref),
			timelineReadingPositionStore?.remove(ref),
		]).catch(() => undefined);
	}
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
				await hydrateCloudChatCatalogPersistence();
				for (const cached of useCloudChatCatalogStore.getState().summaries) {
					registerCloudEnvironmentResolver(cached);
					const cachedProject = localProjectForCloudEnvironment(
						cached.workspaceId,
					);
					if (cachedProject !== null) stageCloudChat(cached, cachedProject);
				}
				const client = await getControlPlaneRpcClient();
				for (const [workspaceId, intent] of Object.entries(
					useCloudChatCatalogStore.getState().archiveIntents,
				)) {
					const cached = cloudSummaryForEnvironment(workspaceId);
					if (cached === null) continue;
					try {
						const archived = await Effect.runPromise(
							client["cloud.workspaces.archive"]({
								workspaceId,
								commandId: intent.commandId,
							}),
						);
						updateSummary({
							...refreshSummaryFromWorkspace(cached, archived),
							archivedAt: intent.requestedAt,
						});
					} catch {
						// The persisted intent remains hidden and retries on the next hydrate.
					}
				}
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
		const archivedAt = Date.now();
		const commandId = crypto.randomUUID();
		const optimistic = optimisticallyArchiveCloudChat(
			summary,
			archivedAt,
			commandId,
		);
		const projectId = localProjectForCloudEnvironment(summary.workspaceId);
		if (projectId !== null) stageCloudChat(optimistic, projectId);
		try {
			const client = await getControlPlaneRpcClient();
			const workspace = await Effect.runPromise(
				client["cloud.workspaces.archive"]({
					workspaceId: summary.workspaceId,
					commandId,
				}),
			);
			updateSummary({
				...refreshSummaryFromWorkspace(summary, workspace),
				archivedAt,
			});
		} catch (cause) {
			set({ error: formatError(cause) });
			// A response can be lost after API durably accepts the command. Keep
			// the persisted intent as the authoritative optimistic fence and retry
			// it during catalog hydration instead of flashing the row back into the
			// active list. Reconciliation clears it only after API publishes the
			// archived lifecycle state.
		}
	},
}));

registerCloudChatCatalogRefresh(() => useCloudChatsStore.getState().hydrate());

export const useCloudChatSummaryForSelection = ({
	chatId,
	sessionId,
}: {
	readonly chatId: ChatId | null;
	readonly sessionId: SessionId | null;
}): CloudChatSummary | null => {
	return useCloudChatCatalogStore((state) =>
		findCloudSummaryForSelection(state.summaries, { chatId, sessionId }),
	);
};

export const useCloudChatSummaryForSession = (
	sessionId: SessionId | null,
): CloudChatSummary | null =>
	useCloudChatSummaryForSelection({ chatId: null, sessionId });
