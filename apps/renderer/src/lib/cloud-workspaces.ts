import {
	cloudChatPlaceholder,
	cloudSessionPlaceholder,
} from "@zuse/client-runtime/cloud-catalog";
import { cloudFailurePresentation } from "@zuse/client-runtime/cloud-failure-presentation";
import {
	openCloudTranscriptCheckpoint,
	openCloudTranscriptPage,
} from "@zuse/client-runtime/cloud-transcript";
import type { EnvironmentWakeIntent } from "@zuse/client-runtime/environment-runtime";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import type {
	ConnectionView,
	ResourceView,
} from "@zuse/client-runtime/resource-state";
import type { SessionTimelineProjection } from "@zuse/contracts";
import {
	type ChatId,
	type CloudChatSummary,
	type CloudWorkspace,
	EnvironmentId,
	FolderId,
	type GitOriginInfo,
	Message,
	MessageId,
	type SessionId,
	WORKSPACE_GATEWAY_PENDING_PROTOCOL,
} from "@zuse/contracts";
import { Duration, Effect, Fiber, Schedule, Stream } from "effect";
import {
	cloudWorkspaceStartupError,
	isCloudWorkspaceAttachable,
	waitForCloudWorkspaceReady,
} from "../lib/cloud-workspace-lifecycle.ts";
import { overlayActiveEnvironmentShell } from "../lib/environment-entities.ts";
import { formatError } from "../lib/format-error.ts";
import { registerCloudWorkspace } from "../lib/rpc-client.ts";
import {
	rememberCloudTimelineHead,
	sessionTimelineCache,
	timelineReadingPositionStore,
} from "../lib/session-timeline-cache.ts";
import {
	addOptimisticSessionMessage,
	getRendererClientBus,
	registerEnvironmentActivation,
	registerSessionTimelineCheckpointSynchronizer,
	registerSessionTimelineOlderPageSynchronizer,
	rendererResourceCacheNamespace,
	retryRendererEnvironmentConnection,
	stopCloudHistory,
} from "../lib/session-timeline-client-bus.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { useArchivePreviewStore } from "../store/archive-preview.ts";
import { useChatsStore } from "../store/chats.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { getCloudControlClient } from "./cloud-control-client.ts";
import {
	beginCloudFetch,
	markCloudCatalogArrival,
	markCloudFetch,
} from "./cloud-fetch-timing.ts";
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
import {
	type EnvironmentShellData,
	environmentShellResourceKey,
	retainEnvironmentShell,
	waitForEnvironmentGateway,
} from "./environment-shell-client-bus.ts";
import { isHostedProduct } from "./hosted-connect.ts";
import { hostedProjectFolderId } from "./hosted-workspace.ts";
import { useOrganizationWorkspaces } from "./organization-workspaces.ts";
import {
	assertRendererAccountCurrent,
	type RendererAccountSnapshot,
	rendererAccountSnapshot,
	subscribeRendererAccount,
} from "./renderer-account.ts";
import {
	assertRendererWorkspaceCurrent,
	rendererWorkspaceSnapshot,
	subscribeRendererWorkspace,
	workspaceScopeKey,
} from "./renderer-workspace.ts";

type CloudChatsState = {
	readonly loading: boolean;
	readonly error: string | null;
	readonly hydrate: () => Promise<void>;
	readonly archive: (summary: CloudChatSummary) => Promise<void>;
};

// Permission denial ends this workspace's feed without treating the account
// credential as expired. Retrying cannot restore membership or billing access.
const catalogAccessDenied = (cause: unknown): boolean => {
	const kind = cloudFailurePresentation({ cause })?.kind;
	return kind === "sign-in-required" || kind === "cloud-access-required";
};

const billingOnlyWorkspace = (): boolean => {
	const { scope } = rendererWorkspaceSnapshot();
	return (
		scope.kind === "organization" &&
		useOrganizationWorkspaces
			.getState()
			.organizations.some(
				(organization) =>
					organization.id === scope.organizationId &&
					organization.role === "billing",
			)
	);
};

const opening = new Map<
	string,
	{
		account: RendererAccountSnapshot;
		workspace: ReturnType<typeof rendererWorkspaceSnapshot>;
		promise: Promise<void>;
	}
>();
type CloudAttachment = {
	account: RendererAccountSnapshot;
	activation: "connect" | "wake";
	wakeAccepted: boolean;
	wakeAcknowledgments: Array<() => void>;
	promise: Promise<void>;
};
const attaching = new Map<string, CloudAttachment>();
const registeredCloudEnvironments = new Map<string, CloudChatSummary>();
const cloudResolverCleanups = new Set<() => void>();
const rearmedClientByWorkspace = new Map<string, string>();
let hydration: Promise<void> | null = null;
let catalogGeneration = 0;
let hydrationRequested = false;

/**
 * An authoritative online runtime is a new recovery signal for a client whose
 * socket exhausted its retry ladder while compute was asleep. Include both
 * lifecycle revision and client generation so each real state change gets one
 * automatic attempt without turning a persistent outage into a retry storm.
 */
export const cloudConnectionRearmKey = (
	summary: CloudChatSummary,
	connection: ConnectionView,
): string | null =>
	isCloudWorkspaceAttachable(summary) && connection.phase === "failed"
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
	const account = rendererAccountSnapshot();
	const environmentId = EnvironmentId.make(summary.workspaceId);
	rearmReadyCloudConnection(
		summary,
		getRendererClientBus().connection(environmentId),
		rearmedClientByWorkspace,
		(retryEnvironmentId) =>
			queueMicrotask(() => {
				if (rendererAccountSnapshot() === account)
					retryRendererEnvironmentConnection(retryEnvironmentId);
			}),
	);
};

const trackCloudAttachment = (
	workspaceId: string,
	activation: CloudAttachment["activation"],
	operation: Promise<void>,
	account: RendererAccountSnapshot,
): Promise<void> => {
	let tracked: Promise<void>;
	tracked = operation.finally(() => {
		if (attaching.get(workspaceId)?.promise === tracked) {
			attaching.delete(workspaceId);
		}
	});
	attaching.set(workspaceId, {
		activation,
		promise: tracked,
		account,
		wakeAccepted: false,
		wakeAcknowledgments: [],
	});
	return tracked;
};

/**
 * Cloud wakeup is an environment capability. Register it when catalog metadata
 * arrives so every ClientBus resource shares one attachment path instead of
 * teaching feature stores how to resume a workspace.
 */
const registerCloudEnvironmentResolver = (summary: CloudChatSummary): void => {
	const account = rendererAccountSnapshot();
	const previous = registeredCloudEnvironments.get(summary.workspaceId);
	if (previous !== undefined) {
		if (compareCloudChatSummaryVersion(summary, previous) < 0) return;
		registeredCloudEnvironments.set(summary.workspaceId, summary);
		rearmRegisteredCloudConnection(summary);
		return;
	}
	registeredCloudEnvironments.set(summary.workspaceId, summary);
	let rootPrepared = false;
	const releaseCheckpoint = registerSessionTimelineCheckpointSynchronizer(
		EnvironmentId.make(summary.workspaceId),
		async (ref, current: ResourceView<SessionTimelineProjection>) => {
			markCloudFetch(ref, "request-start");
			if (rendererAccountSnapshot() !== account) return null;
			const shellKey = environmentShellResourceKey({
				environmentId: ref.environmentId,
			});
			const shellBefore = getRendererClientBus().snapshot(shellKey);
			const control = await getCloudControlClient(
				summary.workspaceScope ?? { kind: "personal" },
			);
			if (rendererAccountSnapshot() !== account) return null;
			markCloudFetch(ref, "control-ready");
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
			markCloudFetch(ref, "downloaded");
			const checkpoint = result.checkpoint;
			if (rendererAccountSnapshot() !== account) return null;
			if (checkpoint === null) return null;
			const payload = await openCloudTranscriptCheckpoint(ref, checkpoint);
			if (rendererAccountSnapshot() !== account) return null;
			markCloudFetch(ref, "decrypted");
			if (payload.context !== undefined) {
				const { chat, session, folder } = payload.context;
				if (chat.id !== summary.chatId)
					throw new Error(
						"Cloud transcript checkpoint belongs to another chat.",
					);
				if (shellBefore.data === null) {
					const initialData: EnvironmentShellData = {
						folders: [folder],
						originsByFolder: {},
						chatsByProject: { [folder.id]: [chat] },
						sessionsByProject: { [folder.id]: [session] },
						creationOperationsByProject: {},
					};
					getRendererClientBus().update(shellKey, {
						expectedGeneration: shellBefore.generation,
						expectedCursor: shellBefore.cursor,
						initialData,
						origin: "checkpoint",
						update: (data) => (data === initialData ? data : undefined),
						persist: true,
					});
				}
			}
			const namespace = rendererResourceCacheNamespace(ref.environmentId);
			if (namespace !== null)
				rememberCloudTimelineHead(
					ref,
					payload.projection,
					payload.cursor,
					namespace,
				);

			return {
				data: payload.projection,
				cursor: payload.cursor,
				resetEpoch:
					current.cursor !== null &&
					current.cursor.epoch !== payload.cursor.epoch,
			};
		},
	);
	const releaseOlderPages = registerSessionTimelineOlderPageSynchronizer(
		EnvironmentId.make(summary.workspaceId),
		async (ref, cursor, beforeSequence) => {
			if (rendererAccountSnapshot() !== account) return null;
			const control = await getCloudControlClient(
				summary.workspaceScope ?? { kind: "personal" },
			);
			if (rendererAccountSnapshot() !== account) return null;
			const result = await Effect.runPromise(
				control["cloud.transcript.messages.page"]({
					workspaceId: summary.workspaceId,
					sessionId: ref.sessionId,
					cursor,
					beforeSequence,
				}),
			);
			const encrypted = result.page;
			if (rendererAccountSnapshot() !== account) return null;
			if (encrypted === null) return null;
			const page = await openCloudTranscriptPage(
				ref,
				cursor,
				beforeSequence,
				encrypted,
			);
			return rendererAccountSnapshot() === account ? page : null;
		},
	);
	const releaseActivation = registerEnvironmentActivation(
		EnvironmentId.make(summary.workspaceId),
		async (activation, wakeIntent) => {
			assertRendererAccountCurrent(account);
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
			await ensureCloudWorkspaceEnvironment(current, activation, wakeIntent);
		},
		async (client) => {
			assertRendererAccountCurrent(account);
			if (rootPrepared) return;
			const folders = await Effect.runPromise(client["workspace.list"]({}));
			assertRendererAccountCurrent(account);
			// The cloud runtime registers the selected checkout before API marks the
			// sandbox repository-ready. Never manufacture a second, placeholder root.
			rootPrepared = folders.length > 0;
		},
		"cloud-workspace",
	);
	cloudResolverCleanups.add(() => {
		releaseCheckpoint();
		releaseOlderPages();
		releaseActivation();
	});
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

/** Resolve account-owned projects even before a runtime mapping exists. */
const projectForSummary = (summary: CloudChatSummary): FolderId | null =>
	isHostedProduct()
		? hostedProjectFolderId(summary.projectId)
		: localProjectForCloudEnvironment(summary.workspaceId);

const updateSummary = (summary: CloudChatSummary): void => {
	const current = cloudSummaryForEnvironment(summary.workspaceId);
	if (current !== null && compareCloudChatSummaryVersion(summary, current) < 0)
		return;
	if (!registerCloudChat(summary)) return;
	const accepted = cloudSummaryForEnvironment(summary.workspaceId) ?? summary;
	registerCloudEnvironmentResolver(accepted);
	const projectId = projectForSummary(summary);
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
	if (!registerCloudChat(summary, projectId)) return;
	const accepted = cloudSummaryForEnvironment(summary.workspaceId) ?? summary;
	registerCloudEnvironmentResolver(accepted);
	const activeSessionId = cloudSummaryActiveSessionId(accepted);
	const chat = cloudChatPlaceholder(
		{ ...accepted, activeSessionId },
		projectId,
	);
	const archives = useArchivePreviewStore.getState();
	if (chat.archivedAt !== null) {
		archives.upsertChat(chat);
	} else if (
		archives.chatsByProject[projectId]?.some((row) => row.id === chat.id)
	) {
		archives.removeChat(chat.id, projectId);
	}
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
				createdAt: new Date(accepted.createdAt),
			}),
		);
	}
	useChatsStore.setState({ error: null });
};

export const openCloudChat = (
	summary: CloudChatSummary,
	projectId?: FolderId,
): Promise<void> => {
	const account = rendererAccountSnapshot();
	const workspace = rendererWorkspaceSnapshot();
	const existing = opening.get(summary.workspaceId);
	if (existing?.account === account && existing.workspace === workspace)
		return existing.promise;
	const operation = Promise.resolve().then(() => {
		assertRendererAccountCurrent(account);
		assertRendererWorkspaceCurrent(workspace);
		if (
			workspaceScopeKey(summary.workspaceScope ?? { kind: "personal" }) !==
			workspace.key
		)
			throw new Error("Select the chat's workspace before opening it.");
		if (projectId === undefined) {
			registerCloudChat(summary);
			registerCloudEnvironmentResolver(summary);
			// A fresh browser has no local checkout. Keep the real runtime identity
			// unbound until its shell arrives rather than inventing a local folder.
			useWorkspaceStore.setState({ selectedFolderId: null });
		} else stageCloudChat(summary, projectId);
		const activeSessionId = cloudSummaryActiveSessionId(summary);
		if (activeSessionId !== null)
			beginCloudFetch({
				environmentId: EnvironmentId.make(summary.workspaceId),
				sessionId: activeSessionId,
			});
		// Catalog selection must not depend on a paused runtime shell. Select the
		// durable ids now so the qualified timeline cache can hydrate immediately.
		useUiStore.getState().setActiveMainTab("chat");
		useChatsStore.setState((state) => ({
			selectedChatId: summary.chatId,
			landingRevision: state.landingRevision + 1,
			selectedChatByProject: {
				...state.selectedChatByProject,
				...(projectId === undefined ? {} : { [projectId]: summary.chatId }),
			},
		}));
		useSessionsStore.setState((state) => ({
			selectedSessionId: activeSessionId,
			selectedSessionByProject: {
				...state.selectedSessionByProject,
				...(projectId === undefined ? {} : { [projectId]: activeSessionId }),
			},
		}));
		if (
			projectId !== undefined &&
			useWorkspaceStore.getState().selectedFolderId !== projectId
		) {
			void useWorkspaceStore.getState().select(projectId);
		}
		// The retained timeline hydrates cache first. EnvironmentRuntime then
		// prepares the gateway and attaches in one ordered background operation.
	});
	const tracked = operation.finally(() => {
		if (opening.get(summary.workspaceId)?.promise === tracked)
			opening.delete(summary.workspaceId);
	});
	opening.set(summary.workspaceId, { account, workspace, promise: tracked });
	return tracked;
};

const workspaceNeedsWake = (
	workspace: Pick<CloudWorkspace, "state" | "desiredState">,
): boolean =>
	workspace.state === "paused" ||
	workspace.state === "failed" ||
	workspace.desiredState === "paused";

/** Cloud is an EnvironmentResolver capability, not a second message path. */
export const ensureCloudWorkspaceAttached = (
	summary: CloudChatSummary,
	activation: "connect" | "wake" = "wake",
	wakeIntent?: EnvironmentWakeIntent,
): Promise<void> => {
	const account = rendererAccountSnapshot();
	// A live, account-owned runtime already authorizes each command. Reuse it
	// instead of minting another gateway ticket for every tab or action.
	const registered = registeredCloudEnvironments.get(summary.workspaceId);
	if (
		registered !== undefined &&
		isCloudWorkspaceAttachable(registered) &&
		registered.desiredState === "ready" &&
		getRendererClientBus().connection(EnvironmentId.make(summary.workspaceId))
			.phase === "connected"
	) {
		wakeIntent?.acknowledge();
		return Promise.resolve();
	}
	const existing = attaching.get(summary.workspaceId);
	if (existing !== undefined && existing.account === account) {
		if (existing.activation === "wake" || activation === "connect") {
			if (wakeIntent !== undefined) {
				if (existing.wakeAccepted) wakeIntent.acknowledge();
				else existing.wakeAcknowledgments.push(wakeIntent.acknowledge);
			}
			return existing.promise;
		}
		// A live command can arrive while a passive transcript attachment is still
		// resolving. Wake is a stronger side effect: never let it inherit the
		// passive request's failure (for example when API has just paused compute).
		const escalated = existing.promise
			.catch(() => undefined)
			.then(() => attachCloudWorkspace(summary, "wake", account, wakeIntent));
		return trackCloudAttachment(
			summary.workspaceId,
			"wake",
			escalated,
			account,
		);
	}
	return trackCloudAttachment(
		summary.workspaceId,
		activation,
		attachCloudWorkspace(summary, activation, account, wakeIntent),
		account,
	);
};

const attachCloudWorkspace = async (
	summary: CloudChatSummary,
	activation: "connect" | "wake",
	account: RendererAccountSnapshot,
	wakeIntent?: EnvironmentWakeIntent,
): Promise<void> => {
	assertRendererAccountCurrent(account);
	const publish = (workspace: CloudWorkspace): void => {
		assertRendererAccountCurrent(account);
		updateSummary(refreshSummaryFromWorkspace(summary, workspace));
	};
	const control = await getCloudControlClient(
		summary.workspaceScope ?? { kind: "personal" },
	);
	assertRendererAccountCurrent(account);
	let workspace = await Effect.runPromise(
		control["cloud.workspaces.get"]({ workspaceId: summary.workspaceId }),
	);
	assertRendererAccountCurrent(account);
	if (workspaceNeedsWake(workspace) && activation === "wake") {
		workspace = await Effect.runPromise(
			control["cloud.workspaces.resume"]({
				workspaceId: summary.workspaceId,
				...(wakeIntent === undefined
					? {}
					: { commandId: wakeIntent.commandId }),
			}),
		);
	}
	assertRendererAccountCurrent(account);
	if (activation === "wake") {
		wakeIntent?.acknowledge();
		const current = attaching.get(summary.workspaceId);
		if (current?.account === account && current.activation === "wake") {
			current.wakeAccepted = true;
			for (const acknowledge of current.wakeAcknowledgments) acknowledge();
			current.wakeAcknowledgments.length = 0;
		}
	}
	publish(workspace);
	const startupError = cloudWorkspaceStartupError(workspace);
	if (startupError !== null) throw startupError;
	if (activation === "connect" && !isCloudWorkspaceAttachable(workspace)) {
		throw new Error(
			workspace.state === "paused"
				? "Cloud workspace is paused."
				: "Cloud workspace is not currently available for passive attachment.",
		);
	}
	// Socket loss only invalidates an attachment ticket. Runtime replacement is
	// owned by the lifecycle reconciler, never inferred from gateway failures.
	const connectionForWorkspace = () => {
		assertRendererAccountCurrent(account);
		return Effect.runPromise(
			control["cloud.workspaces.connect"]({ workspaceId: summary.workspaceId }),
		);
	};
	let connection = await connectionForWorkspace();
	if (
		connection.protocol !== WORKSPACE_GATEWAY_PENDING_PROTOCOL &&
		!isCloudWorkspaceAttachable(workspace)
	) {
		// Previous APIs cannot admit pending attachments. Keep this negotiated
		// bridge only until that deployed protocol has been retired.
		workspace = await waitForCloudWorkspaceReady(
			control["cloud.workspaces.watch"]({
				workspaceId: summary.workspaceId,
				afterRevision: workspace.revision,
			}),
			publish,
		);
		connection = await connectionForWorkspace();
	}
	registerCloudWorkspace(
		summary.workspaceId,
		connection,
		connectionForWorkspace,
		account,
	);
};

/** A launch ticket is not a connected runtime. Keep one shared connection lease
 * until the authenticated handshake succeeds, then let the selected chat retain it. */
export const connectCloudWorkspaceForLaunch = async (
	summary: CloudChatSummary,
): Promise<() => void> => {
	const account = rendererAccountSnapshot();
	registerCloudEnvironmentResolver(summary);
	const retained = retainEnvironmentShell(
		{ environmentId: EnvironmentId.make(summary.workspaceId) },
		"wake",
	);
	try {
		await waitForEnvironmentGateway(
			EnvironmentId.make(summary.workspaceId),
			retained.key,
		);
		assertRendererAccountCurrent(account);
		return () => retained.lease.release();
	} catch (cause) {
		retained.lease.release();
		throw cause;
	}
};

const ensureCloudWorkspaceEnvironment = (
	summary: CloudChatSummary,
	activation: "connect" | "wake",
	wakeIntent?: EnvironmentWakeIntent,
): Promise<void> =>
	ensureCloudWorkspaceAttached(summary, activation, wakeIntent);

export { summaryFromLaunch } from "@zuse/client-runtime/cloud-catalog";
export { cloudSummaryForChat, localProjectForCloudChat };

const removeDeletedCloudPlaceholders = (
	removed: ReadonlyArray<CloudChatSummary>,
): void => {
	if (removed.length === 0) return;
	const chatIds = new Set(removed.map((summary) => summary.chatId));
	const archives = useArchivePreviewStore.getState();
	for (const [projectId, chats] of Object.entries(archives.chatsByProject)) {
		for (const chat of chats) {
			if (chatIds.has(chat.id))
				archives.removeChat(chat.id, FolderId.make(projectId));
		}
	}
	for (const summary of removed) {
		const ref = {
			environmentId: EnvironmentId.make(summary.workspaceId),
			sessionId: summary.initialSessionId,
		};
		const namespace = rendererResourceCacheNamespace(ref.environmentId);
		if (namespace !== null)
			void Promise.all([
				sessionTimelineCache?.remove(ref, namespace),
				timelineReadingPositionStore?.remove(ref, namespace),
			]).catch(() => undefined);
	}
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
		hydrationRequested = true;
		const account = rendererAccountSnapshot();
		const workspace = rendererWorkspaceSnapshot();
		if (typeof account.subject !== "string") return;
		if (billingOnlyWorkspace()) {
			removeDeletedCloudPlaceholders(reconcileCloudChatCatalog([]));
			set({ loading: false, error: null });
			return;
		}
		if (hydration !== null) return hydration;
		const generation = catalogGeneration;
		const pending = (async () => {
			set({ loading: true, error: null });
			try {
				await hydrateCloudChatCatalogPersistence();
				if (rendererAccountSnapshot() !== account) return;
				for (const cached of useCloudChatCatalogStore.getState().summaries) {
					registerCloudEnvironmentResolver(cached);
					const cachedProject = projectForSummary(cached);
					if (cachedProject !== null) stageCloudChat(cached, cachedProject);
				}
				const client = await getCloudControlClient(workspace.scope);
				if (rendererAccountSnapshot() !== account) return;
				if (generation !== catalogGeneration) return;

				const result = await Effect.runPromise(
					client["cloud.chats.list"]({ scope: "all" }),
				);
				if (
					generation !== catalogGeneration ||
					rendererAccountSnapshot() !== account
				)
					return;
				removeDeletedCloudPlaceholders(reconcileCloudChatCatalog(result.chats));
				for (const summary of result.chats) {
					const accepted =
						cloudSummaryForEnvironment(summary.workspaceId) ?? summary;
					registerCloudEnvironmentResolver(accepted);
					const projectId = projectForSummary(accepted);
					if (projectId !== null) stageCloudChat(accepted, projectId);
				}
				void (async () => {
					for (const [workspaceId, intent] of Object.entries(
						useCloudChatCatalogStore.getState().archiveIntents,
					)) {
						if (generation !== catalogGeneration) return;
						const cached = cloudSummaryForEnvironment(workspaceId);
						if (cached === null) continue;
						try {
							const archived = await Effect.runPromise(
								client["cloud.workspaces.archive"]({
									workspaceId,
									commandId: intent.commandId,
								}),
							);
							if (generation !== catalogGeneration) return;
							updateSummary({
								...refreshSummaryFromWorkspace(cached, archived),
								archivedAt: intent.requestedAt,
							});
						} catch {
							// The persisted intent remains hidden and retries on the next hydrate.
						}
					}
				})().catch(() => undefined);
				set({ loading: false });
			} catch (cause) {
				if (
					rendererAccountSnapshot() === account &&
					generation === catalogGeneration
				) {
					if (catalogAccessDenied(cause))
						removeDeletedCloudPlaceholders(reconcileCloudChatCatalog([]));
					set({ error: formatError(cause), loading: false });
				}
			}
		})().finally(() => {
			if (hydration === pending) hydration = null;
		});
		hydration = pending;
		return pending;
	},
	archive: async (summary) => {
		const account = rendererAccountSnapshot();
		const selectedWorkspace = rendererWorkspaceSnapshot();
		const archivedAt = Date.now();
		const commandId = crypto.randomUUID();
		const optimistic = optimisticallyArchiveCloudChat(
			summary,
			archivedAt,
			commandId,
		);
		const projectId = projectForSummary(summary);
		if (projectId !== null) stageCloudChat(optimistic, projectId);
		try {
			const client = await getCloudControlClient(
				summary.workspaceScope ?? { kind: "personal" },
			);
			if (rendererAccountSnapshot() !== account) return;
			const workspace = await Effect.runPromise(
				client["cloud.workspaces.archive"]({
					workspaceId: summary.workspaceId,
					commandId,
				}),
			);
			if (rendererAccountSnapshot() !== account) return;
			if (rendererWorkspaceSnapshot() !== selectedWorkspace) return;
			updateSummary({
				...refreshSummaryFromWorkspace(summary, workspace),
				archivedAt,
			});
		} catch (cause) {
			if (
				rendererAccountSnapshot() === account &&
				rendererWorkspaceSnapshot() === selectedWorkspace
			)
				set({ error: formatError(cause) });
			// A response can be lost after API durably accepts the command. Keep
			// the persisted intent as the authoritative optimistic fence and retry
			// it during catalog hydration instead of flashing the row back into the
			// active list. Reconciliation clears it only after API publishes the
			// archived lifecycle state.
		}
	},
}));

let catalogAccount = rendererAccountSnapshot();
const unsubscribeCatalogAccount = useCloudChatCatalogStore.subscribe(
	(_state, previous) => {
		const current = rendererAccountSnapshot();
		if (current === catalogAccount) return;
		catalogAccount = current;
		removeDeletedCloudPlaceholders(previous.summaries);
	},
);
const unsubscribeAccount = subscribeRendererAccount(() => {
	catalogGeneration++;
	for (const cleanup of cloudResolverCleanups) cleanup();
	cloudResolverCleanups.clear();
	registeredCloudEnvironments.clear();
	rearmedClientByWorkspace.clear();
	opening.clear();
	hydration = null;
	useCloudChatsStore.setState({ loading: false, error: null });
	if (
		hydrationRequested &&
		typeof rendererAccountSnapshot().subject === "string"
	)
		void useCloudChatsStore.getState().hydrate();
});
const unsubscribeWorkspace = subscribeRendererWorkspace(() => {
	catalogGeneration++;
	hydration = null;
	useCloudChatsStore.setState({ loading: false, error: null });
	if (hydrationRequested && rendererAccountSnapshot().subject)
		void useCloudChatsStore.getState().hydrate();
});
if (import.meta.hot)
	import.meta.hot.dispose(() => {
		unsubscribeCatalogAccount();
		unsubscribeAccount();
		unsubscribeWorkspace();
	});

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

/** One account catalog feed owned by the signed-in sidebar lifecycle. */
export const watchCloudChatCatalog = (): (() => void) => {
	if (billingOnlyWorkspace()) return () => {};
	const workspace = rendererWorkspaceSnapshot();
	let stopped = false;
	let cursor: number | undefined;
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	const start = async () => {
		await useCloudChatsStore.getState().hydrate();
		if (stopped || rendererWorkspaceSnapshot() !== workspace) return;
		const stream = Stream.unwrap(
			Effect.tryPromise({
				try: async () =>
					(await getCloudControlClient(workspace.scope))["cloud.chats.watch"]({
						cursor,
					}),
				catch: (cause) => cause,
			}),
		).pipe(
			Stream.retry(
				Schedule.exponential("500 millis").pipe(
					Schedule.modifyDelay(({ duration }) =>
						Effect.succeed(
							Duration.millis(Math.min(Duration.toMillis(duration), 10_000)),
						),
					),
					Schedule.while(({ input }) => !catalogAccessDenied(input)),
				),
			),
		);
		fiber = Effect.runFork(
			Stream.runForEach(stream, (page) =>
				Effect.sync(() => {
					if (
						stopped ||
						rendererWorkspaceSnapshot() !== workspace ||
						(cursor !== undefined && page.cursor < cursor && !page.reset)
					)
						return;
					if (
						!page.reset &&
						page.chats.length === 0 &&
						page.deletedWorkspaceIds.length === 0
					) {
						cursor = page.cursor;
						return;
					}
					const current = useCloudChatCatalogStore.getState().summaries;
					if (!page.reset)
						for (const chat of page.chats)
							if (
								!current.some(
									(existing) => existing.workspaceId === chat.workspaceId,
								)
							)
								markCloudCatalogArrival(new Date(chat.createdAt));
					const deleted = new Set(page.deletedWorkspaceIds);
					const updated = new Map(
						page.chats.map((chat) => [chat.workspaceId, chat]),
					);
					const next = page.reset
						? page.chats
						: [
								...current.filter(
									(chat) =>
										!deleted.has(chat.workspaceId) &&
										!updated.has(chat.workspaceId),
								),
								...page.chats,
							];
					removeDeletedCloudPlaceholders(reconcileCloudChatCatalog(next));
					for (const summary of page.chats) {
						const accepted =
							cloudSummaryForEnvironment(summary.workspaceId) ?? summary;
						registerCloudEnvironmentResolver(accepted);
						const projectId = projectForSummary(accepted);
						if (projectId !== null) stageCloudChat(accepted, projectId);
					}
					cursor = page.cursor;
				}),
			).pipe(
				Effect.catch((error) =>
					Effect.sync(() => {
						if (!stopped && rendererWorkspaceSnapshot() === workspace) {
							if (catalogAccessDenied(error))
								removeDeletedCloudPlaceholders(reconcileCloudChatCatalog([]));
							useCloudChatsStore.setState({ error: formatError(error) });
						}
					}),
				),
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						if (!stopped && rendererWorkspaceSnapshot() === workspace)
							useCloudChatsStore.setState({ error: formatError(cause) });
					}),
				),
			),
		);
	};
	void start().catch((cause) => {
		if (!stopped && rendererWorkspaceSnapshot() === workspace)
			useCloudChatsStore.setState({ error: formatError(cause) });
	});
	return () => {
		stopped = true;
		catalogGeneration++;
		stopCloudHistory();
		if (fiber !== null) void Effect.runPromise(Fiber.interrupt(fiber));
	};
};
