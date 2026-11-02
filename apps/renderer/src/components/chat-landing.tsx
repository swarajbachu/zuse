import { prepareStartupQueue } from "../composer/startup-queue.ts";
import { validateAttachmentFile } from "../lib/attachments.ts";
import "@zuse/i18n/english/shell";
import { subscribeControlPlaneSessionCache } from "~/lib/control-plane-client.ts";
import {
	isCloudProjectFolder,
	mergeCloudProjectFolders,
} from "../lib/cloud-project-folders.ts";
import {
	loadCloudAuth,
	peekCloudAuth,
} from "../lib/cloud-workspace-session-cache.ts";
import { isHostedProduct } from "../lib/hosted-session.ts";
import {
	type CloudAuthLoadState,
	cloudSendBlocker,
	connectedCloudProviders,
} from "../lib/model-picker-availability.ts";
import { environmentBelongsToWorkspace } from "../lib/rpc-client.ts";
import { useCloudProjects } from "../lib/use-cloud-projects.ts";
import { CloudAgentSignInTray } from "./composer/cloud-agent-sign-in-tray.tsx";
import {
	CloudQueuedPrompt,
	CloudQueueStatusHeader,
} from "./composer/cloud-mailbox-queue.tsx";
import "@zuse/i18n/english/common";
import "@zuse/i18n/english/chat";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	type CloudSandboxSetup,
	cloudSandboxSetup,
} from "@zuse/client-runtime/cloud-sandbox-providers";
import {
	resourceRefKey,
	type SessionRef,
} from "@zuse/client-runtime/resource-ref";
import {
	type ChatId,
	type ChatWorkspacePolicy,
	type CloudAccountImage,
	type CloudAuthStatus,
	type CloudProject,
	type CloudProviderOption,
	CommandId,
	ComposerInput,
	defaultModelFor,
	EnvironmentId,
	type ExternalThread,
	type Folder,
	FolderId,
	type MessageId,
	type ProviderId,
	type SessionId,
	type WorktreeCreateSource,
	type WorktreeId,
} from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	ChatDownload01Icon,
	Folder01Icon,
	FolderAddIcon,
} from "@zuse/icons/solid-rounded";
import { ChevronDown, Search, X } from "lucide-react";
import {
	lazy,
	Suspense,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { Button } from "~/components/ui/button.tsx";
import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuSelectionIndicator,
	MenuSeparator,
	MenuTrigger,
} from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast.tsx";
import type {
	PendingDraftAttachment,
	PendingDraftContextFile,
} from "~/composer/draft-attachments";
import {
	finalizeStartupInputWhenReady,
	releaseDraftAttachmentPreviews,
	StartupInputError,
	type StartupInputOptions,
	startupInputNeedsPreparation,
} from "~/composer/startup-input";
import {
	cacheAttachmentPreview,
	forgetAttachmentPreview,
} from "~/lib/attachments.ts";
import { resolveChatRuntimeMode } from "~/lib/auto-worktree";
import {
	type CloudLaunchStep,
	chatLandingProgress,
	cloudLaunchStepLabel,
} from "~/lib/chat-landing-progress";
import { cloudImageReadyForProject } from "~/lib/cloud-image-group.ts";
import { cloudLifecycleLabel } from "~/lib/cloud-queue-status";

const CLOUD_SETUP_MESSAGE = {
	unavailable: "chat:cloud_setup_unavailable",
	"subscription-required": "chat:cloud_setup_subscription_required",
	"connect-repository": "chat:cloud_setup_connect_repository",
	"building-image": "chat:cloud_setup_building_image",
	"rebuild-authentication": "chat:cloud_setup_rebuild_authentication",
	"update-image": "chat:cloud_setup_update_image",
} as const satisfies Record<Exclude<CloudSandboxSetup, "ready">, string>;

import { cloudLaunchRequestForSource } from "~/lib/cloud-launch-source";
import { cloudWorkspaceBetaAvailable } from "~/lib/cloud-machines-availability.ts";
import {
	cloudProviderSizeLabel,
	selectedCloudProvider,
} from "~/lib/cloud-provider-presentation.ts";
import { loadCloudWorkspacePlacement } from "~/lib/cloud-workspace-session-cache.ts";
import {
	connectCloudWorkspaceForLaunch,
	stageCloudChat,
	summaryFromLaunch,
	useCloudChatSummaryForSelection,
} from "~/lib/cloud-workspaces.ts";
import { dispatchCommand } from "~/lib/commands";
import { runCloudControl } from "~/lib/control-plane-client.ts";
import { useActiveEnvironmentEntities } from "~/lib/environment-entity-hooks.ts";
import {
	dispatchEnvironmentShellCommand,
	useEnvironmentShellCatalog,
} from "~/lib/environment-shell-client-bus";
import { newProjectWorkspaceKey } from "~/lib/environment-shell-scope";
import { formatError } from "~/lib/format-error";
import { dispatchGitWorkspaceCommand } from "~/lib/git-workspace-client-bus";
import { newChatPreferences } from "~/lib/new-chat-preferences";
import {
	captureNewChatLanding,
	resetCompletedChatDraft,
} from "~/lib/open-new-chat-landing.ts";
import {
	buildLogicalProjectGroups,
	defaultNewChatTarget,
	type LogicalProjectGroup,
	type LogicalProjectMember,
	landingDefaultProject,
	type NewChatTarget,
	preferredGroupMember,
} from "~/lib/project-groups";
import { getLocalEnvironmentId } from "~/lib/rpc-client";
import {
	discardStagedSessionMessage,
	sendSessionMessage,
	stageSessionMessage,
} from "~/lib/session-actions";
import { useSettingsStore } from "~/lib/settings-client-bus.ts";
import { switchToEnvironment } from "~/lib/switch-environment";
import { cn } from "~/lib/utils";
import { useChatsStore } from "~/store/chats";
import { useComposerBridge } from "~/store/composer-bridge";
import { composerDraftKeyForNewChat } from "~/store/composer-drafts";
import { useEnvironmentCatalogStore } from "~/store/environment-catalog";
import { useExternalThreadsStore } from "~/store/external-threads";
import { currentModelCatalog } from "~/store/model-catalog";
import { DRAFT_SESSION_ID, useSessionsStore } from "~/store/sessions";
import { useUiStore } from "~/store/ui";
import { useWorkspaceStore } from "~/store/workspace";
import { EMPTY_WORKTREES, useWorktreesStore } from "~/store/worktrees";
import { bindCloudWorkspaceToLocalDevice } from "../lib/device-bridge-binding.ts";
import { providerDisplayName } from "../lib/provider-labels.ts";
import {
	assertRendererWorkspaceCurrent,
	rendererWorkspaceSnapshot,
	subscribeRendererWorkspace,
} from "../lib/renderer-workspace.ts";
import {
	type CloudComputerPickerItem,
	ComputerPicker,
} from "./composer/computer-picker.tsx";
import {
	CreateFromMenu,
	type CreateFromSelection,
} from "./composer/create-from-menu.tsx";
import {
	type ComposerWorkspaceMode,
	WorkspacePicker,
} from "./composer/workspace-picker.tsx";
import { ProviderIcon } from "./provider-icons";
import { WallpaperBackground } from "./wallpaper-background";
import { SetupCardView } from "./worktree-setup-card.tsx";

const ChatComposer = lazy(() =>
	import("./chat-composer.tsx").then((module) => ({
		default: module.ChatComposer,
	})),
);
const ProjectSetupDialog = lazy(() =>
	import("./project-setup-dialog.tsx").then((module) => ({
		default: module.ProjectSetupDialog,
	})),
);

export const workspacePolicyForMode = (
	mode: ComposerWorkspaceMode,
): ChatWorkspacePolicy =>
	mode === "worktree" ? { _tag: "fresh" } : { _tag: "main" };

const migrateModelOptions = (
	environmentId: EnvironmentId,
	fromId: string,
	toId: string,
): void => {
	if (typeof window === "undefined") return;
	const prefix = `zuse.modelOptions.${resourceRefKey({ environmentId, sessionId: fromId as SessionId })}.`;
	const unqualifiedPrefix = `zuse.modelOptions.${fromId}.`;
	const legacyPrefix = `memoize.modelOptions.${fromId}.`;
	const moves: Array<[string, string]> = [];
	for (let i = 0; i < window.sessionStorage.length; i++) {
		const key = window.sessionStorage.key(i);
		if (key?.startsWith(prefix)) {
			moves.push([
				key,
				`zuse.modelOptions.${resourceRefKey({ environmentId, sessionId: toId as SessionId })}.${key.slice(prefix.length)}`,
			]);
		} else if (key?.startsWith(unqualifiedPrefix)) {
			moves.push([
				key,
				`zuse.modelOptions.${resourceRefKey({ environmentId, sessionId: toId as SessionId })}.${key.slice(unqualifiedPrefix.length)}`,
			]);
		} else if (key?.startsWith(legacyPrefix)) {
			moves.push([
				key,
				`zuse.modelOptions.${resourceRefKey({ environmentId, sessionId: toId as SessionId })}.${key.slice(legacyPrefix.length)}`,
			]);
		}
	}
	for (const [from, to] of moves) {
		const value = window.sessionStorage.getItem(from);
		if (value !== null) window.sessionStorage.setItem(to, value);
		window.sessionStorage.removeItem(from);
	}
};

const EMPTY_CHATS_BY_PROJECT: Readonly<Record<string, never>> = {};
const CLOUD_WORKSPACE_BETA_AVAILABLE = cloudWorkspaceBetaAvailable();

const formatThreadRelative = (date: Date): string => {
	const ms = Math.max(0, Date.now() - date.getTime());
	const min = Math.floor(ms / 60_000);
	if (min < 1) return "now";
	if (min < 60) return `${min}m`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h`;
	const day = Math.floor(hr / 24);
	return `${day}d`;
};

/**
 * Landing surface shown in the main pane whenever no chat session is
 * selected — including cold start, after archiving the active session, and
 * for fresh users who haven't typed anything yet.
 *
 * Renders a centered "What should we build in <project>?" headline above a
 * mini composer + project picker + starter-prompt list. On submit we call
 * `useChatsStore.create()` with the typed input. Plain prompts become the
 * atomic initial turn; structured or still-materializing inputs use the
 * startup queue. The chat store auto-selects the new session, which causes
 * `MainShell` to swap this surface for `<ChatView />` + `<ChatComposer />` on
 * the next render.
 */
export function ChatLanding() {
	const workspace = useSyncExternalStore(
		subscribeRendererWorkspace,
		rendererWorkspaceSnapshot,
		rendererWorkspaceSnapshot,
	);
	return (
		<WorkspaceChatLanding
			key={`${workspace.key}:${workspace.epoch}`}
			workspace={workspace}
		/>
	);
}

function WorkspaceChatLanding({
	workspace,
}: {
	readonly workspace: ReturnType<typeof rendererWorkspaceSnapshot>;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common", "shell"]);

	const { originsByFolder: runtimeOrigins } = useActiveEnvironmentEntities();
	const storedFolders = useWorkspaceStore((s) => s.folders);
	const cloudProjects = useCloudProjects();
	const selectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
	const selectFolder = useWorkspaceStore((s) => s.select);
	const addFolder = useWorkspaceStore((s) => s.add);
	const externalThreads = useExternalThreadsStore((s) => s.threads);
	const externalThreadsLoading = useExternalThreadsStore((s) => s.loading);
	const externalThreadsError = useExternalThreadsStore((s) => s.error);
	const continuingExternalThreadId = useExternalThreadsStore(
		(s) => s.continuingId,
	);
	const hydrateExternalThreads = useExternalThreadsStore((s) => s.hydrate);
	const continueExternalThread = useExternalThreadsStore(
		(s) => s.continueThread,
	);

	const defaultProviderId = useSettingsStore((s) => s.defaultProviderId);
	const defaultModelByProvider = useSettingsStore(
		(s) => s.defaultModelByProvider,
	);
	const activeEnvironmentId = useEnvironmentCatalogStore(
		(s) => s.activeEnvironmentId,
	);
	const { folders, originsByFolder: origins } = useMemo(
		() =>
			mergeCloudProjectFolders(
				environmentBelongsToWorkspace(activeEnvironmentId, workspace.scope)
					? storedFolders
					: [],
				environmentBelongsToWorkspace(activeEnvironmentId, workspace.scope)
					? runtimeOrigins
					: {},
				cloudProjects,
			),
		[
			activeEnvironmentId,
			workspace,
			storedFolders,
			runtimeOrigins,
			cloudProjects,
		],
	);

	const create = useChatsStore((s) => s.create);
	const beginDraft = useSessionsStore((s) => s.beginDraft);
	const clearDraft = useSessionsStore((s) => s.clearDraft);

	const draftSession = useSessionsStore((s) => s.draftSession);

	const [submitError, setSubmitError] = useState<string | null>(null);
	const [draftAttempt, setDraftAttempt] = useState(0);

	const [submitting, setSubmitting] = useState(false);

	const [pendingInput, setPendingInput] = useState<ComposerInput | null>(null);
	const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);

	const [pendingWorktreeId, setPendingWorktreeId] = useState<WorktreeId | null>(
		null,
	);

	const [pendingCloudStep, setPendingCloudStep] =
		useState<CloudLaunchStep | null>(null);
	const [pendingCloudChatId, setPendingCloudChatId] = useState<ChatId | null>(
		null,
	);
	const pendingCloudSummary = useCloudChatSummaryForSelection({
		chatId: pendingCloudChatId,
		sessionId: null,
	});

	const [createSource, setCreateSource] = useState<{
		readonly kind: CreateFromSelection["kind"];
		readonly selection: CreateFromSelection;
		readonly worktreeId: WorktreeId | null;
		readonly label: string;
		readonly issue: {
			readonly markdown: string;
			readonly title: string;
		} | null;
	} | null>(null);
	const [creatingSource, setCreatingSource] = useState(false);

	const pendingWorktree = useWorktreesStore((s) => {
		if (selectedFolderId === null || pendingWorktreeId === null) return null;
		const list = s.byProject[selectedFolderId] ?? EMPTY_WORKTREES;
		return list.find((w) => w.id === pendingWorktreeId) ?? null;
	});

	const selectedFolder = useMemo(
		() =>
			selectedFolderId === null
				? null
				: (folders.find((f) => f.id === selectedFolderId) ?? null),
		[folders, selectedFolderId, uiMessage],
	);

	const storedCatalogEntries = useEnvironmentCatalogStore((s) => s.entries);
	const catalogEntries = useMemo(
		() =>
			storedCatalogEntries.filter((entry) =>
				environmentBelongsToWorkspace(entry.environmentId, workspace.scope),
			),
		[storedCatalogEntries, workspace],
	);
	const shellViews = useEnvironmentShellCatalog(
		catalogEntries.map((entry) => entry.environmentId),
	);
	const retryProfile = useEnvironmentCatalogStore((s) => s.retry);
	const retryEnvironment = useEnvironmentCatalogStore(
		(s) => s.retryEnvironment,
	);
	const [retryingEnvironmentId, setRetryingEnvironmentId] = useState<
		string | null
	>(null);
	const desktopCatalogEnabled =
		window.zuse?.ssh !== undefined || window.zuse?.tailnet !== undefined;
	const unavailableComputers = catalogEntries.filter(
		(entry) =>
			entry.connectionKind !== "local" &&
			(entry.status === "error" || entry.status === "offline"),
	);
	const retryComputer = (environmentId: string): void => {
		const entry = catalogEntries.find(
			(candidate) => candidate.environmentId === environmentId,
		);
		if (entry === undefined || entry.status === "connecting") return;
		setRetryingEnvironmentId(environmentId);
		const operation =
			entry.profileId === null
				? retryEnvironment(environmentId)
				: retryProfile(entry.profileId);
		void operation
			.catch((cause) =>
				toastManager.add({
					title: uiMessage("chat:chat_landing_could_not_reconnect"),
					description: formatError(cause),
					type: "error",
				}),
			)
			.finally(() => setRetryingEnvironmentId(null));
	};

	const projectGroups = useMemo(
		() =>
			buildLogicalProjectGroups({
				entries: catalogEntries,
				activeEnvironmentId,
				localEnvironmentId: getLocalEnvironmentId(),
				activeFolders: folders,
				activeOrigins: origins,
				activeChatsByProject: EMPTY_CHATS_BY_PROJECT,
				shellsByEnvironment: Object.fromEntries(
					Object.entries(shellViews).map(([environmentId, view]) => [
						environmentId,
						view.data,
					]),
				),
			}),
		[
			catalogEntries,
			activeEnvironmentId,
			folders,
			origins,
			shellViews,
			uiMessage,
		],
	);
	const selectedGroup = useMemo(
		() =>
			selectedFolderId === null
				? null
				: (projectGroups.find((group) =>
						group.members.some(
							(member) =>
								member.isActive && member.folderId === selectedFolderId,
						),
					) ?? null),
		[projectGroups, selectedFolderId, uiMessage],
	);

	const [remoteAnchor, setRemoteAnchor] = useState<{
		readonly groupKey: string;
		readonly member: LogicalProjectMember;
	} | null>(null);
	const cloudOnlyProject = isCloudProjectFolder(
		remoteAnchor?.member.folderId ?? selectedFolderId,
	);
	const cloudOnlyHome =
		cloudOnlyProject || (isHostedProduct() && activeEnvironmentId === "local");
	const anchoredGroup = useMemo(
		() =>
			remoteAnchor === null
				? null
				: (projectGroups.find((group) => group.key === remoteAnchor.groupKey) ??
					null),
		[projectGroups, remoteAnchor],
	);
	const pickerGroup = anchoredGroup ?? selectedGroup;
	const noProject =
		!isHostedProduct() &&
		remoteAnchor === null &&
		(selectedFolderId === null || selectedFolder?.kind === "scratch");
	const scratchIdentity = useRef(
		FolderId.make(`scratch_${crypto.randomUUID()}`),
	);
	const scratchFolder = useRef<Folder | null>(null);
	const submissionInFlight = useRef(false);
	const restoredProject = useRef(false);
	useEffect(() => {
		if (noProject || restoredProject.current || projectGroups.length === 0)
			return;
		restoredProject.current = true;
		const group = landingDefaultProject(
			projectGroups,
			newChatPreferences.lastProjectKey(),
			selectedGroup?.key ?? null,
			useChatsStore.getState().landingRevision > 0,
		);
		if (group === null || group.key === selectedGroup?.key) return;
		const member = preferredGroupMember(group);
		if (member === null) return;
		if (member.isActive) {
			setRemoteAnchor(null);
			void selectFolder(member.folderId);
		} else {
			setRemoteAnchor({ groupKey: group.key, member });
		}
	}, [noProject, projectGroups, selectFolder, selectedGroup?.key]);
	const workspaceChoiceKey =
		remoteAnchor === null
			? `${activeEnvironmentId}:${selectedFolderId ?? "none"}`
			: `${remoteAnchor.member.environmentId}:${remoteAnchor.member.folderId}`;
	const configuredWorkspaceMode: ComposerWorkspaceMode =
		pickerGroup === null
			? "worktree"
			: newChatPreferences.workspaceFor(pickerGroup.key);
	const [workspaceChoice, setWorkspaceChoice] = useState<{
		readonly key: string;
		readonly mode: ComposerWorkspaceMode;
	} | null>(null);
	const workspaceMode = noProject
		? "local"
		: workspaceChoice?.key === workspaceChoiceKey
			? workspaceChoice.mode
			: configuredWorkspaceMode;

	const [targetOverride, setTargetOverride] = useState<NewChatTarget | null>(
		null,
	);
	const [selectedCloudProviderId, setSelectedCloudProviderId] = useState<
		string | null
	>(null);
	const [selectedCloudSizeId, setSelectedCloudSizeId] = useState<string | null>(
		null,
	);
	const cloudTarget = cloudOnlyHome || selectedCloudProviderId !== null;
	const [cloudAccountImages, setCloudAccountImages] = useState<
		ReadonlyArray<CloudAccountImage>
	>([]);
	const snapshotNative = cloudAccountImages.some(
		(image) =>
			image.providerId === selectedCloudProviderId &&
			image.snapshot !== undefined &&
			image.snapshot.agentAuthentication !== "zuse",
	);
	const [cloudAuth, setCloudAuth] = useState<CloudAuthStatus | null>(null);
	const [cloudAuthLoad, setCloudAuthLoad] =
		useState<CloudAuthLoadState>("loading");
	const [cloudAuthAttempt, setCloudAuthAttempt] = useState(0);
	const enabledProviders = useSettingsStore((state) => state.providerEnabled);
	const cloudProviderIds = useMemo(
		() =>
			(snapshotNative
				? (["claude", "codex"] as const)
				: connectedCloudProviders(cloudAuth)
			).filter((id) => enabledProviders[id] !== false),
		[cloudAuth, enabledProviders, snapshotNative],
	);
	useEffect(() => {
		if (!cloudTarget) {
			setCloudAuth(null);
			setCloudAuthLoad("loading");
			return;
		}
		let cancelled = false;
		let loading = false;
		const load = async (refresh: boolean) => {
			if (loading || cancelled) return;
			loading = true;
			try {
				await loadCloudAuth(refresh);
				if (cancelled) return;
				setCloudAuth(peekCloudAuth() ?? null);
				setCloudAuthLoad("ready");
			} catch {
				if (cancelled) return;
				setCloudAuth(null);
				setCloudAuthLoad("failed");
			} finally {
				loading = false;
			}
		};
		setCloudAuthLoad("loading");
		void load(cloudAuthAttempt > 0);
		const unsubscribe = subscribeControlPlaneSessionCache((key) => {
			if (key === "cloud-workspace:auth") {
				setCloudAuth(peekCloudAuth() ?? null);
				void load(false);
			}
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [cloudTarget, cloudAuthAttempt]);

	const cloudAuthBlocker =
		!cloudTarget || draftSession === null
			? null
			: cloudSendBlocker(
					snapshotNative ? "ready" : cloudAuthLoad,
					cloudProviderIds,
				);
	useEffect(() => {
		if (
			!cloudTarget ||
			draftSession === null ||
			cloudProviderIds.includes(draftSession.providerId)
		)
			return;
		const provider = cloudProviderIds[0];
		if (provider !== undefined)
			void useSessionsStore
				.getState()
				.setProvider(
					draftSession.id,
					provider,
					defaultModelByProvider[provider] ??
						defaultModelFor(currentModelCatalog(), provider),
				);
	}, [cloudTarget, cloudProviderIds, draftSession, defaultModelByProvider]);
	const [cloudProviders, setCloudProviders] = useState<
		ReadonlyArray<CloudProviderOption>
	>([]);
	const [cloudProject, setCloudProject] = useState<CloudProject | null>(null);
	const [cloudSubscribed, setCloudSubscribed] = useState(false);
	const [cloudPlacementError, setCloudPlacementError] = useState(false);
	const setView = useUiStore((state) => state.setView);
	const setSettingsSection = useUiStore((state) => state.setSettingsSection);
	const [projectSetupOpen, setProjectSetupOpen] = useState(false);
	const cloudRepositoryIdentity =
		pickerGroup?.origin === null || pickerGroup?.origin === undefined
			? null
			: `${pickerGroup.origin.host}/${pickerGroup.origin.owner}/${pickerGroup.origin.repo}`.toLowerCase();
	useEffect(() => {
		let cancelled = false;
		setSelectedCloudProviderId(null);
		setSelectedCloudSizeId(null);
		setCloudProviders([]);
		setCloudProject(null);
		setCloudAccountImages([]);
		setCloudSubscribed(false);
		setCloudPlacementError(false);
		if (!CLOUD_WORKSPACE_BETA_AVAILABLE || cloudRepositoryIdentity === null)
			return;
		const loadCloudPlacement = async (): Promise<void> => {
			try {
				const placement = await loadCloudWorkspacePlacement();
				const images = placement.images;
				if (cancelled) return;
				const project =
					placement.projects.find(
						(project) =>
							project.repositoryIdentity.toLowerCase() ===
							cloudRepositoryIdentity,
					) ?? null;
				setCloudProviders(placement.providers);
				if (isHostedProduct() || cloudOnlyProject)
					setSelectedCloudProviderId((current) =>
						selectedCloudProvider(
							placement.providers,
							current,
							placement.providers
								.filter((provider) =>
									cloudImageReadyForProject(
										images.find(
											(image) => image.providerId === provider.providerId,
										),
										project?.projectId,
									),
								)
								.map((provider) => provider.providerId),
						),
					);
				setCloudProject(project);
				setCloudAccountImages(images);
				setCloudSubscribed(placement.subscribed);
				setCloudPlacementError(false);
			} catch {
				if (!cancelled) setCloudPlacementError(true);
			}
		};
		void loadCloudPlacement();
		const unsubscribe = subscribeControlPlaneSessionCache((key) => {
			if (
				key === "cloud-workspace:providers" ||
				key === "cloud-workspace:projects" ||
				key === "cloud-workspace:entitlements" ||
				key.startsWith("cloud-workspace:image:")
			)
				void loadCloudPlacement();
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [cloudRepositoryIdentity, cloudOnlyProject]);
	const cloudPickerItems = useMemo<ReadonlyArray<CloudComputerPickerItem>>(
		() =>
			cloudProviders.map((provider) => {
				const cloudAccountImage = cloudAccountImages.find(
					(image) => image.providerId === provider.providerId,
				);
				const ready = cloudImageReadyForProject(
					cloudAccountImage,
					cloudProject?.projectId,
				);
				const setup = cloudSandboxSetup({
					image: cloudAccountImage,
					subscribed: cloudSubscribed,
					projectId: cloudProject?.projectId ?? null,
					placementFailed: cloudPlacementError,
				});
				const statusText =
					setup === "ready" ? null : uiMessage(CLOUD_SETUP_MESSAGE[setup]);
				return {
					providerId: provider.providerId,
					disabled: cloudPlacementError || cloudAccountImage === undefined,
					needsSetup: !cloudSubscribed || !ready,
					statusText,
					sizes: provider.sizes?.map((size) => ({
						sizeId: size.sizeId,
						displayName: cloudProviderSizeLabel(provider.providerId, size),
					})),
				};
			}),
		[
			cloudAccountImages,
			cloudPlacementError,
			cloudProject,
			cloudProviders,
			cloudSubscribed,
			uiMessage,
		],
	);
	const restoredCloudProject = useRef<string | null>(null);
	useEffect(() => {
		if (
			pickerGroup === null ||
			restoredCloudProject.current === pickerGroup.key
		)
			return;
		const remembered = newChatPreferences.environmentFor(pickerGroup.key);
		if (!remembered?.startsWith("cloud:")) return;
		const providerId = remembered.slice("cloud:".length);
		if (
			!cloudPickerItems.some(
				(item) => item.providerId === providerId && item.needsSetup === false,
			)
		)
			return;
		restoredCloudProject.current = pickerGroup.key;
		setTargetOverride(null);
		setSelectedCloudProviderId(providerId);
	}, [cloudPickerItems, pickerGroup]);
	const rememberedEnvironmentId =
		pickerGroup === null
			? null
			: newChatPreferences.environmentFor(pickerGroup.key);
	const rememberedTarget =
		pickerGroup?.members.find(
			(member) => member.environmentId === rememberedEnvironmentId,
		) ?? null;
	const rememberedCatalogTarget = catalogEntries.find(
		(entry) => entry.environmentId === rememberedEnvironmentId,
	);
	const resolvedTarget: NewChatTarget | null =
		selectedCloudProviderId !== null
			? null
			: (targetOverride ??
				(rememberedTarget !== null
					? {
							environmentId: rememberedTarget.environmentId,
							folderId: rememberedTarget.folderId,
						}
					: rememberedCatalogTarget !== undefined
						? {
								environmentId: rememberedCatalogTarget.environmentId,
								folderId: null,
							}
						: null) ??
				(remoteAnchor !== null
					? {
							environmentId: remoteAnchor.member.environmentId,
							folderId: remoteAnchor.member.folderId,
						}
					: pickerGroup !== null
						? defaultNewChatTarget(pickerGroup)
						: null));
	const pendingProjectSetup =
		selectedCloudProviderId === null &&
		resolvedTarget?.folderId === null &&
		pickerGroup?.origin?.cloneUrl !== undefined
			? {
					environmentId: resolvedTarget.environmentId,
					label:
						catalogEntries.find(
							(entry) => entry.environmentId === resolvedTarget.environmentId,
						)?.label ?? "the selected computer",
					url: pickerGroup.origin.cloneUrl,
					name: pickerGroup.displayName,
				}
			: null;
	const importEnvironmentId = EnvironmentId.make(
		resolvedTarget?.environmentId ?? getLocalEnvironmentId(),
	);

	useLayoutEffect(() => {
		let cancelled = false;

		setCreateSource(null);
		setTargetOverride(null);
		setSelectedCloudProviderId(null);
		const draftFolderId = noProject
			? scratchIdentity.current
			: (remoteAnchor?.member.folderId ?? selectedFolderId);
		if (draftFolderId === null) return;
		clearDraft();
		const draftEnvironmentId = EnvironmentId.make(
			remoteAnchor?.member.environmentId ?? activeEnvironmentId,
		);
		void (
			noProject
				? Promise.resolve(useSettingsStore.getState().defaultRuntimeMode)
				: resolveChatRuntimeMode(draftEnvironmentId, draftFolderId)
		).then(
			(runtimeMode) => {
				if (cancelled) return;
				beginDraft({
					projectId: draftFolderId,
					providerId: defaultProviderId,
					model:
						defaultModelByProvider[defaultProviderId] ??
						defaultModelFor(currentModelCatalog(), defaultProviderId),
					runtimeMode,
				});
			},
			(cause) => {
				if (cancelled) return;
				setSubmitError(
					`Couldn't load chat access settings. ${formatError(cause)}`,
				);
			},
		);
		return () => {
			cancelled = true;
			clearDraft();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		activeEnvironmentId,
		selectedFolderId,
		remoteAnchor,
		draftAttempt,
		noProject,
	]);

	const headline =
		anchoredGroup !== null
			? `What should we build in ${anchoredGroup.displayName}?`
			: !noProject && selectedFolder
				? `What should we build in ${selectedFolder.name}?`
				: "What should we build today?";

	const onPickGroup = (group: LogicalProjectGroup) => {
		const member = preferredGroupMember(group);
		if (member === null) return;
		newChatPreferences.rememberProject(group.key);
		if (member.isActive) {
			setRemoteAnchor(null);
			void selectFolder(member.folderId);
			return;
		}
		setRemoteAnchor({ groupKey: group.key, member });
	};
	const onAdd = () => {
		if (isHostedProduct()) {
			setSettingsSection({ kind: "machines" });
			setView("settings");
			return;
		}
		void addFolder();
	};

	const handleCreateFromSelect = async (
		sel: CreateFromSelection,
	): Promise<void> => {
		if (selectedFolderId === null || creatingSource) return;
		setSubmitError(null);
		if (sel.kind === "issue") {
			try {
				const { result: res } = await dispatchGitWorkspaceCommand<
					{ readonly folderId: FolderId; readonly number: number },
					{ readonly markdown: string; readonly title: string }
				>({
					ref: {
						environmentId: EnvironmentId.make(activeEnvironmentId),
						folderId: selectedFolderId,
						worktreeId: null,
						rootPath: selectedFolder?.path ?? "",
					},
					kind: "git.issueMarkdown",
					commandId: CommandId.make(`git-issue:${crypto.randomUUID()}`),
					payload: {
						folderId: selectedFolderId,
						number: sel.number,
					},
				});
				setCreateSource({
					kind: "issue",
					selection: sel,
					worktreeId: null,
					label: `#${sel.number}`,
					issue: { markdown: res.markdown, title: res.title || sel.title },
				});

				const insert = useComposerBridge.getState().insertText;
				if (insert !== null) insert(res.title || sel.title);
			} catch {
				setSubmitError(
					"Couldn't load that issue. Is the GitHub CLI (gh) signed in?",
				);
			}
			return;
		}

		const label =
			sel.kind === "pr" ? `PR #${sel.number} · ${sel.headRefName}` : sel.branch;

		if (selectedCloudProviderId !== null) {
			setCreateSource({
				kind: sel.kind,
				selection: sel,
				worktreeId: null,
				label,
				issue: null,
			});
			return;
		}
		if (sel.existingWorktreeId !== null) {
			setCreateSource({
				kind: sel.kind,
				selection: sel,
				worktreeId: sel.existingWorktreeId,
				label,
				issue: null,
			});
			return;
		}
		const source: WorktreeCreateSource =
			sel.kind === "pr"
				? { _tag: "pr", number: sel.number, headRefName: sel.headRefName }
				: { _tag: "branch", branch: sel.branch, remote: sel.remote };
		setCreatingSource(true);
		const wt = await useWorktreesStore
			.getState()
			.create(selectedFolderId, source);
		setCreatingSource(false);
		if (wt === null) {
			setSubmitError(
				useWorktreesStore.getState().error ?? `Couldn't check out ${label}.`,
			);
			return;
		}
		setCreateSource({
			kind: sel.kind,
			selection: sel,
			worktreeId: wt.id,
			label,
			issue: null,
		});
	};

	const handleDraftSubmit = async (
		input: ComposerInput,
		opts: {
			readonly asGoal: boolean;
			readonly accept: () => void;
			readonly pendingAttachments: ReadonlyArray<PendingDraftAttachment>;
			readonly pendingContextFiles: ReadonlyArray<PendingDraftContextFile>;
		},
	): Promise<void> => {
		if (submitting || rendererWorkspaceSnapshot() !== workspace) return;
		try {
			for (const pending of opts.pendingAttachments)
				validateAttachmentFile(pending.file);
		} catch (error) {
			setSubmitError(formatError(error));
			return;
		}
		if (cloudOnlyHome && selectedCloudProviderId === null) {
			setSubmitError(
				uiMessage(
					"shell:hosted_set_up_a_cloud_workspace_in_settings_before_starting_a_chat",
				),
			);
			return;
		}
		const { draftSession: draft, draftRevision } = useSessionsStore.getState();
		if (draft === null) return;
		const ownsLanding = captureNewChatLanding();
		const resetStaleCompletion = () => {
			if (!ownsLanding()) return;
			resetCompletedChatDraft(draftRevision, () => {
				setPendingInput(null);
				setPendingPrompt(null);
				setPendingWorktreeId(null);
				setPendingCloudStep(null);
				setPendingCloudChatId(null);
				setCreateSource(null);
				setSubmitError(null);
				setSubmitting(false);
				setDraftAttempt((attempt) => attempt + 1);
			});
		};
		if (selectedCloudProviderId !== null) {
			if (!CLOUD_WORKSPACE_BETA_AVAILABLE) return;
			if (isHostedProduct() || cloudOnlyProject) {
				const placement = cloudPickerItems.find(
					(item) => item.providerId === selectedCloudProviderId,
				);
				if (placement?.needsSetup !== false || placement.disabled) {
					setSubmitError(
						placement?.statusText ??
							uiMessage(
								"shell:hosted_finish_cloud_workspace_setup_in_settings_before_starting_a_chat",
							),
					);
					return;
				}
			}
			if (cloudProject === null) {
				setSubmitError(uiMessage("chat:cloud_connect_repository_first"));
				return;
			}
			if (selectedFolderId === null) {
				setSubmitError(
					uiMessage(
						"shell:hosted_select_a_repository_before_starting_a_cloud_chat",
					),
				);
				return;
			}
			if (!cloudProviderIds.includes(draft.providerId)) {
				setSubmitError(
					"Connect this agent in this workspace’s Cloud settings before starting a chat.",
				);
				return;
			}

			const launchSource = cloudLaunchRequestForSource(
				createSource?.selection ?? null,
				cloudProject.defaultBranch,
			);
			if (!launchSource.ok) {
				setSubmitError(launchSource.message);
				return;
			}
			const folderId = selectedFolderId;
			const startupInput = ComposerInput.make({
				...input,
				asGoal: opts.asGoal,
			});
			setSubmitError(null);
			opts.accept();
			setSubmitting(true);
			setPendingPrompt(
				input.text.trim().length > 0 ? input.text.trim() : "New chat",
			);
			setPendingInput(startupInput);
			setPendingCloudStep("creating");
			let staged = false;
			let opened = false;
			let releaseStartupConnection: (() => void) | undefined;
			let stagedMessage: { ref: SessionRef; id: MessageId } | null = null;
			try {
				assertRendererWorkspaceCurrent(workspace);
				const launch = await runCloudControl((control) =>
					control["cloud.workspaces.create"]({
						projectId: cloudProject.projectId,
						providerId: selectedCloudProviderId,
						...(selectedCloudSizeId === null
							? {}
							: { sizeId: selectedCloudSizeId }),
						baseRef: launchSource.ref.baseRef,
						...(launchSource.ref.branch === undefined
							? {}
							: { branch: launchSource.ref.branch }),
						agent: draft.providerId,
						model: draft.model,
						runtimeMode: draft.runtimeMode,
						firstMessage: input.text,
						initialMessageDelivery: "mailbox-v1",
						idempotencyKey: crypto.randomUUID(),
					}),
				);
				await bindCloudWorkspaceToLocalDevice(launch.workspace.workspaceId);
				const title =
					input.text.trim().split(/\r?\n/u, 1)[0]?.slice(0, 80) ||
					launch.workspace.branch;
				const summary = summaryFromLaunch({
					workspaceScope: workspace.scope,
					workspace: launch.workspace,
					repositoryIdentity: cloudProject.repositoryIdentity,
					repositoryDisplayName: cloudProject.displayName,
					title,
					agent: draft.providerId,
					model: draft.model,
					runtimeMode: draft.runtimeMode,
				});
				const sandboxSession: SessionRef = {
					environmentId: EnvironmentId.make(summary.workspaceId),
					sessionId: summary.initialSessionId,
				};
				const startupOptions: StartupInputOptions = {
					issueMarkdown: createSource?.issue?.markdown ?? null,
					pendingContextFiles: opts.pendingContextFiles,
					pendingAttachments: opts.pendingAttachments,
				};

				const needsRuntime =
					startupInputNeedsPreparation(startupOptions) || startupInput.asGoal;
				const usesDurableInitialMessage =
					launch.initialMessageDelivery === "mailbox-v1";
				stageCloudChat(
					summary,
					folderId,
					usesDurableInitialMessage ? undefined : input.text,
				);
				for (const item of opts.pendingAttachments) {
					cacheAttachmentPreview(sandboxSession, item.tempId, item.previewUrl);
				}
				const messageId = usesDurableInitialMessage
					? stageSessionMessage(sandboxSession, startupInput, {
							asGoal: startupInput.asGoal,
						})
					: undefined;
				if (messageId !== undefined)
					stagedMessage = { ref: sandboxSession, id: messageId };
				staged = true;
				setPendingCloudChatId(summary.chatId);
				setPendingCloudStep("starting");

				if (ownsLanding()) {
					useChatsStore.getState().select(summary.chatId);
					opened = true;
				}
				releaseStartupConnection =
					await connectCloudWorkspaceForLaunch(summary);
				assertRendererWorkspaceCurrent(workspace);
				if (!usesDurableInitialMessage) {
					if (needsRuntime) {
						toastManager.add({
							type: "error",
							get title() {
								return uiMessage(
									"chat:chat_landing_cloud_workspace_started_without_your_attachments",
								);
							},
							get description() {
								return uiMessage(
									"chat:chat_landing_this_cloud_api_version_delivers_the_first_message_itself_send_the",
								);
							},
						});
					}

					useSessionsStore.getState().clearDraft(draftRevision);
					setSelectedCloudProviderId(null);
					setCreateSource(null);
					return;
				}

				let finalInput = startupInput;
				if (needsRuntime) {
					setPendingCloudStep("preparing");
					finalInput = await finalizeStartupInputWhenReady(
						startupInput,
						{ ref: sandboxSession, uploadRoot: null },
						startupOptions,
					);
				}
				setPendingCloudStep("sending");
				const accepted = await sendSessionMessage(sandboxSession, finalInput, {
					asGoal: startupInput.asGoal,
					providerId: draft.providerId,
					messageId,
				});
				if (!accepted) return;
				useSessionsStore.getState().clearDraft(draftRevision);
				setSelectedCloudProviderId(null);
				setCreateSource(null);
			} catch (cause) {
				if (stagedMessage !== null)
					discardStagedSessionMessage(stagedMessage.ref, stagedMessage.id);
				const message =
					cause instanceof StartupInputError
						? cause.message
						: formatError(cause);

				if (opened) {
					toastManager.add({
						type: "error",
						get title() {
							return uiMessage(
								"chat:chat_landing_couldn_t_send_your_first_cloud_message",
							);
						},
						description: message,
					});
				} else {
					setSubmitError(message);
				}
				setPendingPrompt(null);
			} finally {
				releaseStartupConnection?.();
				if (stagedMessage !== null) {
					for (const item of opts.pendingAttachments)
						forgetAttachmentPreview(stagedMessage.ref, item.tempId);
				}
				setPendingInput(null);
				releaseDraftAttachmentPreviews(opts.pendingAttachments);
				setPendingCloudStep(null);
				setPendingCloudChatId(null);
				setSubmitting(false);
				if (staged) resetStaleCompletion();
			}
			return;
		}
		let submissionFolderId = selectedFolderId;
		if (noProject) {
			setSubmitting(true);
			setSubmitError(null);
			try {
				const folder =
					scratchFolder.current ??
					(
						await dispatchEnvironmentShellCommand<unknown, Folder>({
							environmentId: EnvironmentId.make(
								targetOverride?.environmentId ?? activeEnvironmentId,
							),
							kind: "workspace.createScratch",
							commandId: CommandId.make(
								`create-scratch:${scratchIdentity.current}`,
							),
							payload: {
								id: scratchIdentity.current,
								title: input.text,
								workspaceKey: newProjectWorkspaceKey(
									targetOverride?.environmentId ?? activeEnvironmentId,
								),
							},
							retry: "safe",
						})
					).result;
				scratchFolder.current = folder;
				if (!ownsLanding()) {
					setSubmitting(false);
					return;
				}
				submissionFolderId = folder.id;

				if (
					(targetOverride?.environmentId ?? activeEnvironmentId) ===
					activeEnvironmentId
				)
					useWorkspaceStore.setState((state) => ({
						folders: state.folders.some((entry) => entry.id === folder.id)
							? state.folders
							: [...state.folders, folder],
					}));
			} catch (cause) {
				setSubmitError(formatError(cause));
				setSubmitting(false);
				return;
			}
		}
		const target = noProject
			? {
					environmentId: targetOverride?.environmentId ?? activeEnvironmentId,
					folderId: submissionFolderId,
				}
			: resolvedTarget;
		if (target !== null && target.folderId === null) {
			setSubmitError(
				"Clone this project onto the selected computer before starting the chat.",
			);
			return;
		}
		const remoteTarget =
			target !== null &&
			target.folderId !== null &&
			(target.environmentId !== activeEnvironmentId ||
				(!noProject && target.folderId !== selectedFolderId))
				? { environmentId: target.environmentId, folderId: target.folderId }
				: null;
		if (remoteTarget !== null) {
			if (
				opts.pendingAttachments.length > 0 ||
				opts.pendingContextFiles.length > 0 ||
				createSource !== null ||
				opts.asGoal
			) {
				setSubmitError(
					"Attachments, context files, goals, and Create-from aren't supported yet when starting a chat on another computer.",
				);
				setSubmitting(false);
				return;
			}
			setSubmitError(null);
			opts.accept();
			setSubmitting(true);
			setPendingPrompt(
				input.text.trim().length > 0 ? input.text.trim() : "New chat",
			);
			const remoteResult = await create(
				remoteTarget.folderId,
				draft.providerId,
				draft.model,
				{
					environmentId: remoteTarget.environmentId,
					runtimeMode: draft.runtimeMode,
					permissionMode: draft.permissionMode,
					workspacePolicy: workspacePolicyForMode(workspaceMode),
					workspaceRequested: workspaceMode === "worktree",
					startupInput: ComposerInput.make({ ...input, asGoal: false }),
				},
			);
			if (remoteResult === null) {
				setSubmitError(
					useChatsStore.getState().error ??
						`Couldn't start ${draft.providerId} on the selected computer.`,
				);
				setPendingPrompt(null);
				setSubmitting(false);
				return;
			}
			if (!ownsLanding()) {
				resetStaleCompletion();
				return;
			}
			const switched = await switchToEnvironment({
				environmentId: remoteTarget.environmentId,
				folderId: remoteTarget.folderId,
				chatId: remoteResult.chatId,
				seed: remoteResult.remoteSeed,
				isCurrent: ownsLanding,
			});
			if (!switched.switched && !ownsLanding()) {
				resetStaleCompletion();
				return;
			}
			useSessionsStore.getState().clearDraft(draftRevision);
			setRemoteAnchor(null);
			setTargetOverride(null);
			if (!switched.switched) {
				setSubmitError(
					"The chat was created, but the computer disconnected before it could open. It will appear in the sidebar when the computer reconnects.",
				);
				setPendingPrompt(null);
			}
			setSubmitting(false);
			return;
		}
		if (submissionFolderId === null) return;
		const startupInput = ComposerInput.make({ ...input, asGoal: opts.asGoal });
		const startupOptions: StartupInputOptions = {
			issueMarkdown: createSource?.issue?.markdown ?? null,
			pendingContextFiles: opts.pendingContextFiles,
			pendingAttachments: opts.pendingAttachments,
		};
		const startupNeedsPreparation =
			startupInputNeedsPreparation(startupOptions);
		setSubmitError(null);
		opts.accept();
		setSubmitting(true);
		setPendingPrompt(
			input.text.trim().length > 0 ? input.text.trim() : "New chat",
		);

		const workspacePolicy: ChatWorkspacePolicy =
			createSource !== null && createSource.worktreeId !== null
				? { _tag: "existing", worktreeId: createSource.worktreeId }
				: workspacePolicyForMode(workspaceMode);
		const result = await create(
			submissionFolderId,
			draft.providerId,
			draft.model,
			{
				runtimeMode: draft.runtimeMode,
				permissionMode: draft.permissionMode,
				workspacePolicy,
				workspaceRequested:
					(createSource !== null && createSource.worktreeId !== null) ||
					workspaceMode === "worktree",
				startupInput,
				startupReady: !startupNeedsPreparation,
			},
		);
		if (result === null) {
			const reason =
				useChatsStore.getState().error ??
				`Couldn't start ${draft.providerId}. Check that its CLI is installed and signed in.`;
			setSubmitError(reason);
			setPendingPrompt(null);
			setPendingWorktreeId(null);
			setSubmitting(false);
			return;
		}
		const worktreeId = result.worktreeId;
		setPendingWorktreeId(worktreeId);
		const sessionId = result.initialSessionId;
		const startupQueueId = result.startupQueueId;
		migrateModelOptions(
			EnvironmentId.make(activeEnvironmentId),
			DRAFT_SESSION_ID,
			sessionId,
		);

		if (startupNeedsPreparation && startupQueueId !== null) {
			const sent = await prepareStartupQueue(
				startupInput,
				{
					ref: {
						environmentId: EnvironmentId.make(activeEnvironmentId),
						sessionId,
					},
					uploadRoot: null,
				},
				startupOptions,
				startupQueueId,
			);
			// The queue owns both the error and retry bytes after navigation.
			// Keep the accepted draft cleared even when preparation failed.
			useSessionsStore.getState().clearDraft(draftRevision);
			if (!sent) {
				setPendingPrompt(null);
				setPendingWorktreeId(null);
				setSubmitting(false);
				return;
			}
		}

		setCreateSource(null);
		useSessionsStore.getState().clearDraft(draftRevision);
	};

	const pendingCloudQueue =
		submitting && pendingPrompt !== null && pendingCloudStep !== null ? (
			<div>
				<CloudQueueStatusHeader
					status={{
						busy: true,
						label: cloudLaunchStepLabel(
							pendingCloudStep,
							cloudLifecycleLabel({
								summary: pendingCloudSummary,
								activity: null,
								connection: "dormant",
							}),
						),
					}}
				/>
				<CloudQueuedPrompt
					text={pendingInput?.text ?? pendingPrompt}
					attachmentNames={(pendingInput?.attachments ?? []).map(
						(file) => file.originalName,
					)}
				/>
			</div>
		) : null;
	const composer =
		draftSession !== null ? (
			<Suspense fallback={<div className="h-28" aria-busy="true" />}>
				<ChatComposer
					cloudProviderIds={cloudTarget ? cloudProviderIds : undefined}
					constrain={!submitting}
					submitDisabled={
						submitting ||
						pendingProjectSetup !== null ||
						(cloudTarget && !cloudProviderIds.includes(draftSession.providerId))
					}
					key={
						remoteAnchor !== null
							? `remote:${remoteAnchor.member.environmentId}:${remoteAnchor.member.folderId}`
							: `${activeEnvironmentId}:${selectedFolderId ?? "none"}`
					}
					session={draftSession}
					environmentId={EnvironmentId.make(
						remoteAnchor?.member.environmentId ?? activeEnvironmentId,
					)}
					composerDraftKey={composerDraftKeyForNewChat(
						EnvironmentId.make(
							remoteAnchor?.member.environmentId ?? activeEnvironmentId,
						),
						workspace.scope,
					)}
					projectlessDraft={noProject}
					onDraftSubmit={(input, opts) => {
						if (submissionInFlight.current) return;
						submissionInFlight.current = true;
						void handleDraftSubmit(input, opts)
							.catch((cause) => {
								setSubmitError(formatError(cause));
								setSubmitting(false);
							})
							.finally(() => {
								submissionInFlight.current = false;
							});
					}}
					draftTray={
						pendingCloudQueue ??
						(cloudAuthBlocker === null ? undefined : (
							<CloudAgentSignInTray
								blocker={cloudAuthBlocker}
								onRetry={() => setCloudAuthAttempt((attempt) => attempt + 1)}
								onOpenSettings={() => {
									setSettingsSection({ kind: "cloud", page: "agents" });
									setView("settings");
								}}
							/>
						))
					}
					headerSlot={
						submitting ? undefined : (
							<div className="flex w-full items-center justify-between gap-2">
								<div className="flex min-w-0 items-center gap-1.5">
									<ProjectPicker
										groups={projectGroups}
										selectedFolderId={selectedFolderId}
										noProjectSelected={noProject}
										selectedName={
											noProject
												? uiMessage("chat:no_project")
												: (anchoredGroup?.displayName ??
													selectedFolder?.name ??
													null)
										}
										onPickGroup={onPickGroup}
										onNoProject={
											isHostedProduct()
												? undefined
												: () => {
														setRemoteAnchor(null);
														void selectFolder(null);
													}
										}
										onAdd={onAdd}
									/>
									{desktopCatalogEnabled || cloudPickerItems.length > 0 ? (
										<ComputerPicker
											group={noProject ? null : pickerGroup}
											includeComputers={!cloudOnlyHome}
											target={
												noProject
													? (targetOverride ?? {
															environmentId: activeEnvironmentId,
															folderId: null,
														})
													: resolvedTarget
											}
											entries={catalogEntries}
											onPickTarget={(target) => {
												if (selectedCloudProviderId !== null)
													setCreateSource(null);
												setSelectedCloudProviderId(null);
												setTargetOverride(target);
												scratchFolder.current = null;
												if (pickerGroup !== null)
													newChatPreferences.rememberEnvironment(
														pickerGroup.key,
														target.environmentId,
													);
											}}
											cloudItems={noProject ? [] : cloudPickerItems}
											selectedCloudProviderId={selectedCloudProviderId}
											selectedCloudSizeId={selectedCloudSizeId}
											onPickCloudSize={setSelectedCloudSizeId}
											onPickCloud={(providerId) => {
												if (
													cloudPickerItems.find(
														(item) => item.providerId === providerId,
													)?.needsSetup !== false
												) {
													setSettingsSection({ kind: "machines" });
													setView("settings");
													return;
												}
												if (selectedCloudProviderId === null)
													setCreateSource(null);
												setTargetOverride(null);
												if (providerId !== selectedCloudProviderId)
													setSelectedCloudSizeId(null);
												setSelectedCloudProviderId(providerId);
												if (pickerGroup !== null)
													newChatPreferences.rememberEnvironment(
														pickerGroup.key,
														`cloud:${providerId}`,
													);
											}}
											onRetryEnvironment={retryComputer}
										/>
									) : null}
									{!noProject &&
									selectedCloudProviderId === null &&
									!cloudOnlyHome ? (
										<WorkspacePicker
											value={workspaceMode}
											onValueChange={(mode) => {
												setWorkspaceChoice({
													key: workspaceChoiceKey,
													mode,
												});
												if (pickerGroup !== null)
													newChatPreferences.rememberWorkspace(
														pickerGroup.key,
														mode,
													);
											}}
										/>
									) : null}

									{!cloudOnlyHome && workspace.scope.kind === "personal" && (
										<ImportChatMenu
											threads={externalThreads}
											loading={externalThreadsLoading}
											error={externalThreadsError}
											continuingId={continuingExternalThreadId}
											onOpen={() =>
												void hydrateExternalThreads(importEnvironmentId)
											}
											onImport={(thread) =>
												void continueExternalThread(thread, importEnvironmentId)
											}
										/>
									)}
								</div>
								<div className="flex min-w-0 items-center gap-1.5">
									{createSource !== null && (
										<span className="flex min-w-0 items-center gap-1 overflow-x-auto">
											{createSource.kind === "issue" ? (
												<span>
													{uiMessage(
														"chat:chat_landing_issueattached_sentence",
														{ value: createSource.label ?? "" },
													)}
												</span>
											) : (
												<span className="max-w-[16rem] truncate">
													{createSource.label}
												</span>
											)}
											<button
												type="button"
												onClick={() => setCreateSource(null)}
												aria-label={uiMessage(
													"chat:chat_landing_clear_create_from_source",
												)}
												className="shrink-0 rounded p-0.5 hover:bg-muted hover:text-foreground"
											>
												<X className="size-3" strokeWidth={2} />
											</button>
										</span>
									)}
									{creatingSource && (
										<Spinner className="size-3.5 text-muted-foreground" />
									)}

									{!noProject && remoteAnchor === null && !cloudOnlyHome ? (
										<CreateFromMenu
											environmentId={EnvironmentId.make(activeEnvironmentId)}
											folderId={selectedFolderId}
											rootPath={selectedFolder?.path ?? ""}
											onSelect={(sel) => void handleCreateFromSelect(sel)}
										/>
									) : null}
								</div>
							</div>
						)
					}
				/>
			</Suspense>
		) : projectGroups.length > 0 ? (
			<p className="text-center text-sm text-muted-foreground">
				{uiMessage("chat:chat_landing_choose_a_project_in_the_sidebar")}
			</p>
		) : (
			<div className="flex flex-col items-center gap-3">
				<p className="text-center text-sm text-muted-foreground">
					{uiMessage("chat:chat_landing_add_a_project_to_start")}
				</p>
				{isHostedProduct() ? null : (
					<Button
						size="xs"
						className="h-7"
						onClick={() => dispatchCommand("open-project")}
					>
						<HugeiconsIcon icon={FolderAddIcon} aria-hidden />
						{uiMessage("chat:chat_landing_add_project")}
					</Button>
				)}
			</div>
		);

	if (submitting && pendingPrompt !== null) {
		const progress = chatLandingProgress({
			cloudStep: pendingCloudStep,
			hasPendingWorktree:
				pendingWorktreeId !== null ||
				workspaceMode === "worktree" ||
				(createSource !== null && createSource.worktreeId !== null),
		});
		if (progress.kind === "cloud") {
			return (
				<div className="chat-session-layout relative flex min-h-0 min-w-0 flex-1 flex-col [container-type:inline-size]">
					<div className="min-h-0 flex-1" />
					<div className="shrink-0 px-[var(--chat-row-gutter)] pb-4 pt-2">
						<div className="mx-auto w-full max-w-[var(--chat-reading-column)]">
							{composer}
						</div>
					</div>
				</div>
			);
		}
		return (
			<div className="chat-session-layout relative flex min-h-0 min-w-0 flex-1 flex-col [container-type:inline-size]">
				<div className="min-h-0 flex-1 overflow-y-auto">
					{progress.kind === "worktree" ? (
						<div className="px-[var(--chat-row-gutter)] pt-3">
							<div className="mx-auto w-full max-w-[var(--chat-reading-column)]">
								<SetupCardView
									data={{
										repoName: selectedFolder?.name ?? "this repo",
										hasWorktree:
											pendingWorktreeId !== null ||
											workspaceMode === "worktree",
										worktreePending: pendingWorktree === null,
										worktreeName: pendingWorktree?.name ?? null,
										branch: pendingWorktree?.branch ?? null,
										baseBranch: pendingWorktree?.baseBranch ?? null,
										setupStatus: pendingWorktree?.setupStatus ?? null,
										setupOutput: pendingWorktree?.setupOutput ?? "",
										onRerun: null,
									}}
								/>
							</div>
						</div>
					) : null}
				</div>
				<div className="px-4 pb-4">
					<QueuedComposerPreview prompt={pendingPrompt} status="Queued" />
				</div>
			</div>
		);
	}

	return (
		<div className="relative isolate flex min-h-0 flex-1 flex-col items-center overflow-hidden px-6 pb-4 pt-8 max-[800px]:px-4">
			<WallpaperBackground />
			<div className="relative flex min-h-0 w-full max-w-3xl flex-1 flex-col">
				<div className="flex min-h-0 flex-1 items-center justify-center pb-6">
					<div className="flex flex-col items-center gap-2">
						<h1 className="text-center text-2xl font-medium tracking-[-0.015em] text-foreground">
							{headline}
						</h1>
						{!noProject && !isHostedProduct() ? (
							<button
								type="button"
								onClick={() => {
									setRemoteAnchor(null);
									void selectFolder(null);
								}}
								className="h-7 text-xs text-muted-foreground hover:text-foreground"
							>
								{uiMessage("chat:start_without_project")}
							</button>
						) : null}
					</div>
				</div>
				<div className="flex shrink-0 flex-col gap-3">
					{unavailableComputers.length > 0 ? (
						<div
							role="status"
							aria-live="polite"
							className="mx-auto flex w-full max-w-2xl items-center gap-2.5 rounded-lg border border-border/60 bg-muted/35 px-3 py-2"
						>
							<span className="size-1.5 shrink-0 rounded-full bg-destructive/80" />
							<p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
								<span className="font-medium text-foreground/90">
									{unavailableComputers.length === 1
										? unavailableComputers[0]?.label
										: uiMessage("chat:chat_landing_computers", {
												value1: String(unavailableComputers.length),
											})}
								</span>{" "}
								{unavailableComputers.length === 1
									? uiMessage("chat:chat_landing_is_unavailable")
									: uiMessage("chat:chat_landing_are_unavailable")}{" "}
								{uiMessage("chat:chat_landing_zuse_will_keep_trying")}
							</p>
							<button
								type="button"
								disabled={retryingEnvironmentId !== null}
								className="inline-flex h-6 shrink-0 items-center rounded-md border border-border/60 bg-muted px-2 text-[10px] font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
								onClick={() => {
									for (const entry of unavailableComputers) {
										retryComputer(entry.environmentId);
									}
								}}
							>
								{retryingEnvironmentId === null
									? uiMessage("common:retry")
									: uiMessage("chat:chat_landing_retrying")}
							</button>
						</div>
					) : null}

					{pendingProjectSetup !== null ? (
						<div className="mx-auto flex w-full max-w-2xl items-center gap-3 rounded-lg border border-border bg-muted/45 px-3 py-2">
							<div className="min-w-0 flex-1">
								<p className="text-xs font-medium text-foreground">
									{uiMessage(
										"chat:chat_landing_this_project_isn_t_on_sentence",
										{ value: pendingProjectSetup.label },
									)}
								</p>
								<p className="text-[11px] text-muted-foreground">
									{uiMessage(
										"chat:chat_landing_clone_it_there_before_starting_this_chat",
									)}
								</p>
							</div>
							<button
								type="button"
								className="inline-flex min-h-8 shrink-0 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring"
								onClick={() => setProjectSetupOpen(true)}
							>
								{uiMessage("chat:chat_landing_clone_project")}
							</button>
						</div>
					) : null}

					{submitError !== null && (
						<div className="mx-auto flex w-full max-w-2xl items-start gap-2 rounded-lg border border-rose-400/30 bg-rose-500/[0.08] px-3 py-2 text-[12px] text-rose-200">
							<span className="mt-px shrink-0">⚠</span>
							<span className="flex-1 leading-snug">{submitError}</span>
							{isHostedProduct() && (
								<Button
									className="h-7"
									size="xs"
									variant="ghost"
									onClick={() => {
										setSettingsSection({ kind: "machines" });
										setView("settings");
									}}
								>
									{uiMessage("common:settings")}
								</Button>
							)}
							{draftSession === null ? (
								<Button
									className="h-7"
									size="xs"
									variant="ghost"
									onClick={() => {
										setSubmitError(null);
										setDraftAttempt((attempt) => attempt + 1);
									}}
								>
									{uiMessage("common:retry")}
								</Button>
							) : null}
							<button
								type="button"
								onClick={() => setSubmitError(null)}
								aria-label={uiMessage("chat:chat_landing_dismiss_error")}
								className="-mr-1 shrink-0 rounded p-0.5 text-rose-200/80 hover:bg-rose-500/[0.12] hover:text-rose-100"
							>
								<X className="size-3.5" strokeWidth={1.8} />
							</button>
						</div>
					)}

					{composer}
					{isHostedProduct() && selectedFolderId === null && (
						<button
							type="button"
							className="mx-auto h-7 rounded-md bg-primary px-3 text-xs text-primary-foreground"
							onClick={() => {
								setSettingsSection({ kind: "machines" });
								setView("settings");
							}}
						>
							{uiMessage("shell:hosted_set_up_cloud_agents_and_repositories")}
						</button>
					)}
				</div>
			</div>
			{projectSetupOpen && pendingProjectSetup !== null ? (
				<Suspense fallback={null}>
					<ProjectSetupDialog
						open
						onOpenChange={setProjectSetupOpen}
						initialMode="clone"
						initialEnvironmentId={pendingProjectSetup.environmentId}
						sourceUrl={pendingProjectSetup.url}
						sourceName={pendingProjectSetup.name}
						onComplete={(folder, environmentId) => {
							setTargetOverride({ environmentId, folderId: folder.id });
							setSubmitError(null);
						}}
					/>
				</Suspense>
			) : null}
		</div>
	);
}

export function ImportChatMenu({
	threads,
	loading,
	error,
	continuingId,
	onOpen,
	onImport,
}: {
	threads: ReturnType<typeof useExternalThreadsStore.getState>["threads"];
	loading: boolean;
	error: string | null;
	continuingId: string | null;
	onOpen: () => void;
	onImport: (
		thread: ReturnType<
			typeof useExternalThreadsStore.getState
		>["threads"][number],
	) => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	const [query, setQuery] = useState("");
	const importableThreads = useMemo(
		() => threads.filter(isImportableThread),
		[threads, uiMessage],
	);
	const visibleThreads = useMemo(
		() => filterImportThreads(importableThreads, query),
		[importableThreads, query, uiMessage],
	);
	return (
		<Menu
			onOpenChange={(open) => {
				if (open) onOpen();
				else setQuery("");
			}}
		>
			<MenuTrigger
				className="flex h-7 min-w-0 items-center gap-1.5 rounded-full border border-transparent bg-transparent px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[popup-open]:bg-accent data-[popup-open]:text-foreground"
				aria-label={uiMessage("chat:chat_landing_import_an_existing_chat")}
			>
				<HugeiconsIcon icon={ChatDownload01Icon} className="size-3.5" />
				<span>{uiMessage("chat:chat_landing_import_chat")}</span>
				<ChevronDown className="size-3 opacity-60" />
			</MenuTrigger>
			<MenuPopup side="top" align="start" className="w-72 p-1">
				<div className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">
					{uiMessage("chat:chat_landing_recent_provider_chats")}
				</div>
				<div className="px-1 pb-1.5">
					<div className="flex h-7 items-center gap-2 rounded-md border border-border bg-background/50 px-2 focus-within:border-ring">
						<Search className="size-3.5 shrink-0 text-muted-foreground" />
						<input
							type="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							onKeyDown={(event) => event.stopPropagation()}
							placeholder={uiMessage("chat:chat_landing_search_chats")}
							aria-label={uiMessage("chat:chat_landing_search_imported_chats")}
							className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
						/>
					</div>
				</div>
				<div className="max-h-52 overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-width:thin]">
					{loading && importableThreads.length === 0 ? (
						<div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
							<Spinner className="size-3.5" />
							{uiMessage("chat:chat_landing_finding_chats")}
						</div>
					) : error !== null && importableThreads.length === 0 ? (
						<div className="px-2 py-2 text-xs text-destructive">
							{uiMessage(
								"chat:chat_landing_couldn_t_load_chats_close_and_reopen_this_menu_to_retry",
							)}
						</div>
					) : importableThreads.length === 0 ? (
						<div className="px-2 py-2 text-xs text-muted-foreground">
							{uiMessage("chat:chat_landing_no_recent_chats_found")}
						</div>
					) : visibleThreads.length === 0 ? (
						<div className="px-2 py-3 text-xs text-muted-foreground">
							{uiMessage("chat:chat_landing_no_chats_match_sentence", {
								value: query.trim(),
							})}
						</div>
					) : (
						visibleThreads.map((thread) => {
							const active = continuingId === thread.id;
							const projectLabel = importThreadProjectLabel(thread);
							return (
								<MenuItem
									key={thread.id}
									disabled={!thread.available || continuingId !== null}
									onClick={() => onImport(thread)}
									className="grid min-h-8 grid-cols-[auto_1fr_auto] items-start gap-x-2 px-2 py-1"
									title={thread.projectPath}
								>
									<ProviderIcon
										providerId={thread.providerId}
										className="col-start-1 row-span-2 mt-0.5 size-3.5 self-start"
									/>
									<span className="col-start-2 row-start-1 truncate text-[11px] font-medium leading-4">
										{thread.title}
									</span>
									{projectLabel === null ? null : (
										<span className="col-start-2 row-start-2 truncate text-[9px] leading-3 text-muted-foreground">
											{projectLabel}
										</span>
									)}
									{active ? (
										<Spinner className="col-start-3 row-span-2 mt-0.5 size-3 self-start" />
									) : (
										<span className="col-start-3 row-span-2 mt-0.5 self-start whitespace-nowrap text-[9px] leading-3 text-muted-foreground">
											{formatThreadRelative(thread.updatedAt)}
										</span>
									)}
								</MenuItem>
							);
						})
					)}
				</div>
			</MenuPopup>
		</Menu>
	);
}

const HIDDEN_IMPORT_PROJECT_NAMES = new Set([
	"t",
	"temp",
	"temporary",
	"temporary folder",
]);

export const isImportableThread = (thread: ExternalThread): boolean =>
	thread.available &&
	thread.projectPath.trim().length > 0 &&
	!HIDDEN_IMPORT_PROJECT_NAMES.has(thread.projectName.trim().toLowerCase());

const importThreadProjectLabel = (thread: ExternalThread): string | null => {
	const projectName = thread.projectName.trim();
	if (
		projectName.length <= 1 ||
		HIDDEN_IMPORT_PROJECT_NAMES.has(projectName.toLowerCase())
	)
		return null;
	return projectName;
};

export function filterImportThreads(
	threads: ReadonlyArray<ExternalThread>,
	query: string,
): ReadonlyArray<ExternalThread> {
	const normalized = query.trim().toLocaleLowerCase();
	if (normalized.length === 0) return threads;
	return threads.filter((thread) =>
		[
			thread.title,
			thread.preview,
			thread.projectName,
			thread.projectPath,
			providerThreadLabel(thread.providerId),
		].some((value) => value.toLocaleLowerCase().includes(normalized)),
	);
}

function providerThreadLabel(providerId: ProviderId): string {
	if (providerId === "claude") return "Claude Code";
	if (providerId === "codex") return "Codex";
	return providerDisplayName(providerId);
}

function QueuedComposerPreview({
	prompt,
	status,
}: {
	readonly prompt: string;
	readonly status: string;
}) {
	return (
		<div className="mx-auto w-full max-w-3xl overflow-hidden rounded-md border border-border/50 bg-muted/20 text-[11px]">
			<div className="border-b border-border/40 px-3 py-1.5 font-medium text-muted-foreground">
				{status}
			</div>
			<div className="px-3 py-2 text-foreground/80">{prompt}</div>
		</div>
	);
}

function ProjectPicker({
	groups,
	selectedFolderId,
	noProjectSelected,
	selectedName,
	onPickGroup,
	onNoProject,
	onAdd,
}: {
	groups: ReadonlyArray<LogicalProjectGroup>;
	selectedFolderId: FolderId | null;
	noProjectSelected: boolean;
	selectedName: string | null;
	onPickGroup: (group: LogicalProjectGroup) => void;
	onNoProject?: () => void;
	onAdd: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	const [query, setQuery] = useState("");
	const visibleGroups = useMemo(() => {
		const normalized = query.trim().toLocaleLowerCase();
		if (normalized === "") return groups;
		return groups.filter((group) =>
			group.displayName.toLocaleLowerCase().includes(normalized),
		);
	}, [groups, query, uiMessage]);

	return (
		<Menu onOpenChange={(open) => !open && setQuery("")}>
			<MenuTrigger
				className="flex h-7 min-w-0 max-w-[14rem] items-center gap-1.5 rounded-full border border-transparent bg-transparent px-2.5 text-[11px] text-foreground transition-colors hover:bg-accent data-[popup-open]:bg-accent"
				aria-label={uiMessage("chat:chat_landing_pick_a_project")}
			>
				<HugeiconsIcon icon={Folder01Icon} className="size-3.5" />
				<span className="truncate">
					{selectedName ?? uiMessage("chat:chat_landing_pick_a_project")}
				</span>
				<ChevronDown className="size-3 opacity-60" />
			</MenuTrigger>
			<MenuPopup side="bottom" align="start" className="w-64 p-1">
				<div className="px-1 pb-1.5">
					<div className="flex h-7 items-center gap-2 rounded-md border border-border bg-background/50 px-2 focus-within:border-ring">
						<Search className="size-3.5 shrink-0 text-muted-foreground" />
						<input
							type="search"
							value={query}
							onChange={(event) => setQuery(event.currentTarget.value)}
							onKeyDown={(event) => event.stopPropagation()}
							placeholder={uiMessage("chat:chat_landing_search_projects")}
							aria-label={uiMessage("chat:chat_landing_search_projects_2")}
							className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
						/>
					</div>
				</div>
				<div className="max-h-48 overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-width:thin]">
					{onNoProject ? (
						<MenuItem
							role="menuitemradio"
							aria-checked={noProjectSelected}
							onClick={onNoProject}
							className={cn(
								"grid min-h-8 grid-cols-[1fr_auto] items-center gap-x-2 rounded-md px-2 py-1 text-xs",
								noProjectSelected
									? "bg-accent/40 text-accent-foreground data-highlighted:bg-accent/60"
									: undefined,
							)}
						>
							<span className="col-start-1 row-start-1 truncate">
								{uiMessage("chat:no_project")}
							</span>
							<MenuSelectionIndicator
								checked={noProjectSelected}
								className="col-start-2 row-start-1 justify-self-end"
							/>
						</MenuItem>
					) : null}
					{groups.length === 0 ? (
						<div className="px-2 py-1.5 text-xs text-muted-foreground">
							{uiMessage("chat:chat_landing_no_projects_yet")}
						</div>
					) : visibleGroups.length === 0 ? (
						<div className="px-2 py-2 text-xs text-muted-foreground">
							{uiMessage("chat:chat_landing_no_projects_match_sentence", {
								value: query.trim(),
							})}
						</div>
					) : (
						visibleGroups.map((group) => {
							const active = group.members.some(
								(member) =>
									member.isActive && member.folderId === selectedFolderId,
							);
							const disabled = preferredGroupMember(group) === null;
							return (
								<MenuItem
									key={group.key}
									role="menuitemradio"
									aria-checked={active}
									disabled={disabled}
									onClick={() => onPickGroup(group)}
									className={cn(
										"grid min-h-8 grid-cols-[auto_1fr_auto] items-center gap-x-2 rounded-md px-2 py-1 text-xs",
										active
											? "bg-accent/40 text-accent-foreground data-highlighted:bg-accent/60"
											: undefined,
									)}
								>
									<HugeiconsIcon
										icon={Folder01Icon}
										className="col-start-1 row-start-1 size-3.5 opacity-80"
									/>
									<span className="col-start-2 row-start-1 truncate">
										{group.displayName}
									</span>
									<MenuSelectionIndicator
										checked={active}
										className="col-start-3 row-start-1 justify-self-end"
									/>
								</MenuItem>
							);
						})
					)}
				</div>
				<MenuSeparator />
				<MenuItem
					onClick={onAdd}
					className="grid min-h-8 grid-cols-[1rem_auto_1fr] items-center gap-x-2 rounded-md px-2 py-1 text-xs"
				>
					<span className="col-start-1 row-start-1" />
					<HugeiconsIcon
						icon={FolderAddIcon}
						className="col-start-2 row-start-1 size-3.5 opacity-80"
					/>
					<span className="col-start-3 row-start-1">
						{uiMessage("chat:chat_landing_add_new_project")}
					</span>
				</MenuItem>
			</MenuPopup>
		</Menu>
	);
}
