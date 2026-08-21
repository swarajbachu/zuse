import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import type { ResourceView } from "@zuse/client-runtime/resource-state";
import type { SessionTimelineProjection } from "@zuse/contracts";
import {
	Chat,
	CLOUD_TRANSCRIPT_CHECKPOINT_SCHEMA_VERSION,
	type CloudChatSummary,
	CloudTranscriptCheckpointPayload,
	CloudTranscriptMessagePagePayload,
	type CloudWorkspace,
	EnvironmentId,
	type FolderId,
	type GitOriginInfo,
	Message,
	MessageId,
	type ProviderId,
	Session,
	type SessionId,
} from "@zuse/contracts";
import {
	cloudTranscriptAdditionalData,
	decryptCloudTranscript,
	sha256Base64Url,
} from "@zuse/utils/cloud-transcript-crypto";
import { Effect, Schema } from "effect";
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
	registerEnvironmentActivation,
	registerSessionTimelineCheckpointSynchronizer,
	registerSessionTimelineOlderPageSynchronizer,
} from "../lib/session-timeline-client-bus.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { useChatsStore } from "../store/chats.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import {
	cloudSummaryForChat,
	cloudSummaryForEnvironment,
	cloudSummaryForSession,
	compareCloudChatSummaryVersion,
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
let hydration: Promise<void> | null = null;

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
					cursor: current.cursor ?? undefined,
				}),
			);
			const checkpoint = result.checkpoint;
			if (checkpoint === null) return null;
			if (
				checkpoint.metadata.workspaceId !== summary.workspaceId ||
				checkpoint.metadata.sessionId !== ref.sessionId ||
				(await sha256Base64Url(checkpoint.ciphertext)) !==
					checkpoint.metadata.ciphertextSha256
			)
				throw new Error("Cloud transcript checkpoint failed integrity checks");
			const plaintext = await decryptCloudTranscript({
				encodedKey: checkpoint.transcriptKey,
				additionalData: cloudTranscriptAdditionalData({
					workspaceId: summary.workspaceId,
					sessionId: ref.sessionId,
					epoch: checkpoint.metadata.cursor.epoch,
					version: checkpoint.metadata.cursor.version,
					schemaVersion: CLOUD_TRANSCRIPT_CHECKPOINT_SCHEMA_VERSION,
				}),
				ciphertext: checkpoint.ciphertext,
			});
			const payload = Schema.decodeUnknownSync(
				CloudTranscriptCheckpointPayload,
			)(JSON.parse(new TextDecoder().decode(plaintext)));
			if (
				payload.workspaceId !== summary.workspaceId ||
				payload.sessionId !== ref.sessionId ||
				payload.cursor.epoch !== checkpoint.metadata.cursor.epoch ||
				payload.cursor.version !== checkpoint.metadata.cursor.version
			)
				throw new Error("Cloud transcript checkpoint metadata mismatch");
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
			if (
				encrypted.beforeSequence !== beforeSequence ||
				encrypted.cursor.epoch !== cursor.epoch ||
				encrypted.cursor.version !== cursor.version ||
				(await sha256Base64Url(encrypted.ciphertext)) !==
					encrypted.ciphertextSha256
			)
				throw new Error("Cloud transcript page failed integrity checks");
			const plaintext = await decryptCloudTranscript({
				encodedKey: encrypted.transcriptKey,
				additionalData: cloudTranscriptAdditionalData({
					workspaceId: summary.workspaceId,
					sessionId: ref.sessionId,
					epoch: cursor.epoch,
					version: cursor.version,
					schemaVersion: CLOUD_TRANSCRIPT_CHECKPOINT_SCHEMA_VERSION,
					pageBeforeSequence: beforeSequence,
				}),
				ciphertext: encrypted.ciphertext,
			});
			const page = Schema.decodeUnknownSync(CloudTranscriptMessagePagePayload)(
				JSON.parse(new TextDecoder().decode(plaintext)) as unknown,
			);
			if (
				page.workspaceId !== summary.workspaceId ||
				page.sessionId !== ref.sessionId ||
				page.beforeSequence !== beforeSequence ||
				page.cursor.epoch !== cursor.epoch ||
				page.cursor.version !== cursor.version
			)
				throw new Error("Cloud transcript page belongs to another resource");
			return {
				messages: page.messages,
				olderMessageSequence: page.olderMessageSequence,
			};
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
			// The cloud runtime registers the selected checkout before Relay marks the
			// sandbox repository-ready. Never manufacture a second, placeholder root.
			rootPrepared = folders.length > 0;
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

const sessionStatus = (summary: CloudChatSummary): Session["status"] =>
	summary.state === "failed" ? "error" : "idle";

/** Metadata fallback for rendering a cached transcript without a live shell. */
export const cloudSessionPlaceholder = (
	summary: CloudChatSummary,
	projectId: FolderId,
): Session => {
	const now = new Date(summary.createdAt);
	return Session.make({
		id: summary.initialSessionId,
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
};

/**
 * Relay catalog rows are placeholders only. The environment runtime timeline
 * replaces this shell as soon as the user retains the chat resource.
 */
export const stageCloudChat = (
	summary: CloudChatSummary,
	projectId: FolderId,
	firstMessage?: string,
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
	const session = cloudSessionPlaceholder(accepted, projectId);
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
	if (firstMessage !== undefined) {
		addOptimisticSessionMessage(
			{
				environmentId: EnvironmentId.make(accepted.workspaceId),
				sessionId: accepted.initialSessionId,
			} satisfies SessionRef,
			Message.make({
				id: MessageId.make(`launch:${accepted.workspaceId}:message`),
				sessionId: accepted.initialSessionId,
				role: "user",
				content: { _tag: "user", text: firstMessage, goal: false },
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
			selectedSessionId: summary.initialSessionId,
			selectedSessionByProject: {
				...state.selectedSessionByProject,
				[projectId]: summary.initialSessionId,
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
		// passive request's failure (for example when Relay has just paused compute).
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
	failureDiagnostic: input.workspace.failureDiagnostic,
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
			// A response can be lost after Relay durably accepts the command. Keep
			// the persisted intent as the authoritative optimistic fence and retry
			// it during catalog hydration instead of flashing the row back into the
			// active list. Reconciliation clears it only after Relay publishes the
			// archived lifecycle state.
		}
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
