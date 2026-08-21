import { HugeiconsIcon } from "@hugeicons/react";
import { resourceRefKey } from "@zuse/client-runtime/resource-ref";
import {
	type AttachmentRef,
	type ChatId,
	type ChatWorkspacePolicy,
	type CloudProject,
	type CloudProviderOption,
	CommandId,
	ComposerInput,
	defaultModelFor,
	EnvironmentId,
	type ExternalThread,
	type FolderId,
	type LinearContextFile,
	type LinearContextWarning,
	type LinearIssueSummary,
	type ProviderId,
	type SessionId,
	type WorktreeCreateSource,
	type WorktreeId,
} from "@zuse/contracts";
import {
	ChatDownload01Icon,
	Folder01Icon,
	FolderAddIcon,
	Tick01Icon,
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
} from "react";
import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuSeparator,
	MenuTrigger,
} from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast.tsx";
import {
	appendContextFileRef,
	finalizeDraftAttachments,
	finalizeDraftContextFiles,
	type PendingDraftAttachment,
	type PendingDraftContextFile,
} from "~/composer/draft-attachments";
import { applyPreparedLinearContext } from "~/composer/linear-context-input";
import { uploadAttachment } from "~/lib/attachments";
import { resolveChatWorkspacePolicy } from "~/lib/auto-worktree";
import { chatLandingProgress } from "~/lib/chat-landing-progress";
import { cloudWorkspaceBetaAvailable } from "~/lib/cloud-machines-availability.ts";
import {
	ensureCloudWorkspaceAttached,
	stageCloudChat,
	summaryFromLaunch,
} from "~/lib/cloud-workspaces.ts";
import { saveContextFile, saveContextText } from "~/lib/context-handoff";
import { runControlPlane } from "~/lib/control-plane-client.ts";
import { useActiveEnvironmentEntities } from "~/lib/environment-entity-hooks.ts";
import {
	dispatchEnvironmentShellCommand,
	useEnvironmentShellCatalog,
} from "~/lib/environment-shell-client-bus";
import { formatError } from "~/lib/format-error";
import { dispatchGitWorkspaceCommand } from "~/lib/git-workspace-client-bus";
import {
	buildLogicalProjectGroups,
	defaultNewChatTarget,
	type LogicalProjectGroup,
	type LogicalProjectMember,
	type NewChatTarget,
	preferredGroupMember,
} from "~/lib/project-groups";
import { getLocalEnvironmentId } from "~/lib/rpc-client";
import { updateQueuedMessage } from "~/lib/session-actions";
import { useSettingsStore } from "~/lib/settings-client-bus.ts";
import { switchToEnvironment } from "~/lib/switch-environment";
import { cn } from "~/lib/utils";
import { useChatsStore } from "~/store/chats";
import { useComposerBridge } from "~/store/composer-bridge";
import {
	composerDraftKeyForLanding,
	composerDraftKeyForRemoteLanding,
} from "~/store/composer-drafts";
import { useEnvironmentCatalogStore } from "~/store/environment-catalog";
import { useExternalThreadsStore } from "~/store/external-threads";
import {
	repositorySettingsKey,
	useRepositorySettingsStore,
} from "~/store/repository-settings.ts";
import { DRAFT_SESSION_ID, useSessionsStore } from "~/store/sessions";
import { useUiStore } from "~/store/ui";
import { useWorkspaceStore } from "~/store/workspace";
import { EMPTY_WORKTREES, useWorktreesStore } from "~/store/worktrees";
import { PROVIDER_LABEL } from "../lib/provider-labels.ts";
import {
	type CloudComputerPickerItem,
	ComputerPicker,
} from "./composer/computer-picker.tsx";
import {
	CreateFromMenu,
	type CreateFromSelection,
} from "./composer/create-from-menu.tsx";
import { ProviderIcon } from "./provider-icons";
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

/**
 * Copy the per-session model options (reasoning/effort level + Claude fast
 * mode) that the draft composer wrote under the sentinel draft id over to the
 * real session id, so picks made on the landing carry into the first turn.
 * `ReasoningPicker`/`FastModeToggle` both key sessionStorage by sessionId.
 */
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

/**
 * The landing pickers only need group membership (which repos on which
 * computers), never the merged chat lists — so the builder gets an empty
 * chat map instead of subscribing this surface to every chat update.
 */
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
 * `useChatsStore.create()` with the typed input held in the startup queue; the
 * chat store auto-selects the new session, which causes `MainShell` to
 * swap this surface for `<ChatView />` + `<ChatComposer />` on the next
 * render.
 */
export function ChatLanding() {
	const { originsByFolder: origins } = useActiveEnvironmentEntities();
	const folders = useWorkspaceStore((s) => s.folders);
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
	const defaultRuntimeMode = useSettingsStore((s) => s.defaultRuntimeMode);
	const defaultAutoCreateWorktree = useSettingsStore(
		(s) => s.defaultAutoCreateWorktree,
	);
	const activeEnvironmentId = useEnvironmentCatalogStore(
		(s) => s.activeEnvironmentId,
	);
	const repositoryAutoCreateWorktree = useRepositorySettingsStore((s) =>
		selectedFolderId === null
			? false
			: s.byProject[
					repositorySettingsKey(
						EnvironmentId.make(activeEnvironmentId),
						selectedFolderId,
					)
				]?.autoCreateWorktree === true,
	);

	const create = useChatsStore((s) => s.create);
	const uploadOne = uploadAttachment;
	const beginDraft = useSessionsStore((s) => s.beginDraft);
	const clearDraft = useSessionsStore((s) => s.clearDraft);
	// The synthetic draft session that drives the real ChatComposer below. Its
	// model/runtime/permission/provider live here (routed by the sessions-store
	// setters) and are read back at submit so the picks carry into create().
	const draftSession = useSessionsStore((s) => s.draftSession);

	const [submitError, setSubmitError] = useState<string | null>(null);
	// Local "submit in flight" flag. Covers the whole creation window —
	// including the worktree-create step — so the bridge shows the moment the
	// user hits send rather than after the worktree exists.
	const [submitting, setSubmitting] = useState(false);
	// Snapshot of the prompt the user just submitted. Drives the inline
	// setup-card bridge so the form can be hidden during the RPC without the
	// user losing visual continuity with what they sent (shown as queued).
	const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
	// The worktree resolved for this submit (null = main checkout). Lets the
	// bridge card show the real worktree name/branch the instant it exists.
	const [pendingWorktreeId, setPendingWorktreeId] = useState<WorktreeId | null>(
		null,
	);
	const [pendingCloudStatus, setPendingCloudStatus] = useState<string | null>(
		null,
	);
	// The provider chosen in the composer for this submit (may differ from the
	// default — e.g. the user switched to Grok). Drives the bridge card's
	// "Starting <provider>" label so it matches what's actually booting.

	// The PR / branch / issue the user chose via "Create from…", if any. For a
	// PR/branch we eagerly check out a worktree (or reuse an "In use" one) and
	// pin `worktreeId`; the first send binds the chat to it. For an issue we
	// stash its Markdown + prefill the composer with the title — no worktree.
	const [createSource, setCreateSource] = useState<{
		readonly kind: CreateFromSelection["kind"];
		readonly worktreeId: WorktreeId | null;
		readonly label: string;
		readonly issue: {
			readonly markdown: string;
			readonly title: string;
		} | null;
		readonly linear: {
			readonly issues: ReadonlyArray<LinearIssueSummary>;
			readonly mode: "combined" | "separate";
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
		[folders, selectedFolderId],
	);

	const catalogEntries = useEnvironmentCatalogStore((s) => s.entries);
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
					title: "Could not reconnect",
					description: formatError(cause),
					type: "error",
				}),
			)
			.finally(() => setRetryingEnvironmentId(null));
	};

	// One picker row per repo across machines. In hosted mode the catalog is
	// empty, so groups degrade to exactly the active workspace's folders.
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
		[catalogEntries, activeEnvironmentId, folders, origins, shellViews],
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
		[projectGroups, selectedFolderId],
	);

	// A project that exists ONLY on other computers, chosen from the project
	// picker. Anchoring shows its composer WITHOUT switching the app there —
	// the machine is decided per chat, at submit.
	const [remoteAnchor, setRemoteAnchor] = useState<{
		readonly groupKey: string;
		readonly member: LogicalProjectMember;
	} | null>(null);
	// Explicit "Run on" pick for the pending draft. Null = the group default
	// (this desktop's member when present, else the first connected one).
	const [targetOverride, setTargetOverride] = useState<NewChatTarget | null>(
		null,
	);
	const [selectedCloudProviderId, setSelectedCloudProviderId] = useState<
		string | null
	>(null);
	const [cloudProviders, setCloudProviders] = useState<
		ReadonlyArray<CloudProviderOption>
	>([]);
	const [cloudProject, setCloudProject] = useState<CloudProject | null>(null);
	const [cloudSubscribed, setCloudSubscribed] = useState(false);
	const [cloudPlacementError, setCloudPlacementError] = useState(false);
	const setView = useUiStore((state) => state.setView);
	const setSettingsSection = useUiStore((state) => state.setSettingsSection);
	const cloudCacheRefreshRequests = useRef(new Set<string>());
	const [projectSetupOpen, setProjectSetupOpen] = useState(false);
	const anchoredGroup = useMemo(
		() =>
			remoteAnchor === null
				? null
				: (projectGroups.find((group) => group.key === remoteAnchor.groupKey) ??
					null),
		[projectGroups, remoteAnchor],
	);
	const pickerGroup = anchoredGroup ?? selectedGroup;
	const cloudRepositoryIdentity =
		pickerGroup?.origin === null || pickerGroup?.origin === undefined
			? null
			: `${pickerGroup.origin.host}/${pickerGroup.origin.owner}/${pickerGroup.origin.repo}`.toLowerCase();
	useEffect(() => {
		let cancelled = false;
		let refreshTimer: ReturnType<typeof setTimeout> | undefined;
		cloudCacheRefreshRequests.current.clear();
		setSelectedCloudProviderId(null);
		setCloudProviders([]);
		setCloudProject(null);
		setCloudSubscribed(false);
		setCloudPlacementError(false);
		if (!CLOUD_WORKSPACE_BETA_AVAILABLE || cloudRepositoryIdentity === null)
			return;
		const loadCloudPlacement = async (): Promise<void> => {
			try {
				const [providerResult, projectResult, entitlementResult] =
					await Promise.all([
						runControlPlane((client) => client["cloud.providers"]()),
						runControlPlane((client) => client["cloud.projects.list"]()),
						runControlPlane((client) => client["machines.entitlements"]()),
					]);
				if (cancelled) return;
				const project =
					projectResult.projects.find(
						(project) =>
							project.repositoryIdentity.toLowerCase() ===
							cloudRepositoryIdentity,
					) ?? null;
				const subscribed = entitlementResult.entitlements.some(
					(item) =>
						item.kind === "cloud-workspace" &&
						(item.status === "active" ||
							item.status === "grace" ||
							(item.status === "ended" &&
								item.paidThrough !== undefined &&
								item.paidThrough > Date.now())),
				);
				setCloudProviders(providerResult.providers);
				setCloudProject(project);
				setCloudSubscribed(subscribed);
				setCloudPlacementError(false);

				const staleProviders =
					project === null || !subscribed
						? []
						: providerResult.providers.filter((provider) => {
								const latest = project.latestBuilds[provider.providerId];
								return (
									project.activeBuilds[provider.providerId] === undefined &&
									(latest?.state === "ready" || latest?.state === "failed")
								);
							});
				for (const provider of staleProviders) {
					const latest = project?.latestBuilds[provider.providerId];
					if (project === null || latest === undefined) continue;
					const requestKey = `${project.projectId}:${provider.providerId}`;
					if (cloudCacheRefreshRequests.current.has(requestKey)) continue;
					cloudCacheRefreshRequests.current.add(requestKey);
					try {
						await runControlPlane((client) =>
							client["cloud.projects.prepare"]({
								projectId: project.projectId,
								providerId: provider.providerId,
								idempotencyKey: `automatic-refresh:${requestKey}:${latest.buildId}`,
							}),
						);
					} catch (cause) {
						cloudCacheRefreshRequests.current.delete(requestKey);
						throw cause;
					}
				}
				const buildIsChanging =
					staleProviders.length > 0 ||
					(project !== null &&
						Object.values(project.latestBuilds).some(
							(build) =>
								build.state === "queued" ||
								build.state === "building" ||
								build.state === "sanitizing",
						));
				if (buildIsChanging && !cancelled)
					refreshTimer = setTimeout(() => {
						void loadCloudPlacement();
					}, 2_000);
			} catch {
				if (!cancelled) setCloudPlacementError(true);
			}
		};
		void loadCloudPlacement();
		return () => {
			cancelled = true;
			if (refreshTimer !== undefined) clearTimeout(refreshTimer);
		};
	}, [cloudRepositoryIdentity]);
	const cloudPickerItems = useMemo<ReadonlyArray<CloudComputerPickerItem>>(
		() =>
			cloudProviders.map((provider) => {
				const build = cloudProject?.latestBuilds[provider.providerId];
				const ready =
					cloudProject?.activeBuilds[provider.providerId] !== undefined;
				const statusText = cloudPlacementError
					? "Unavailable"
					: !cloudSubscribed
						? "Subscription required"
						: cloudProject === null
							? "Connect repository"
							: ready || build !== undefined
								? provider.displayName
								: "Getting ready";
				return {
					providerId: provider.providerId,
					providerLabel: provider.displayName,
					disabled: cloudPlacementError || !cloudSubscribed,
					statusText,
				};
			}),
		[cloudPlacementError, cloudProject, cloudProviders, cloudSubscribed],
	);
	const resolvedTarget: NewChatTarget | null =
		selectedCloudProviderId !== null
			? null
			: (targetOverride ??
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

	// Spin up (or re-spin, on project switch) the draft session that backs the
	// composer. Re-runs only when the project changes — model/provider/runtime
	// edits the user makes inside the composer mutate the draft in place, so we
	// must not clobber them on unrelated default-settings changes.
	useLayoutEffect(() => {
		// A create-from source is scoped to the project it was picked in, and a
		// "Run on" override to the draft it was picked for.
		setCreateSource(null);
		setTargetOverride(null);
		setSelectedCloudProviderId(null);
		const draftFolderId = remoteAnchor?.member.folderId ?? selectedFolderId;
		if (draftFolderId === null) {
			clearDraft();
			return;
		}
		beginDraft({
			projectId: draftFolderId,
			providerId: defaultProviderId,
			model:
				defaultModelByProvider[defaultProviderId] ??
				defaultModelFor(defaultProviderId),
			runtimeMode: defaultRuntimeMode,
		});
		return () => clearDraft();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeEnvironmentId, selectedFolderId, remoteAnchor]);

	const headline =
		anchoredGroup !== null
			? `What should we build in ${anchoredGroup.displayName}?`
			: selectedFolder
				? `What should we build in ${selectedFolder.name}?`
				: "What should we build today?";

	// Picking a group resolves to its preferred member: the active environment
	// first, else the first connected computer. A remote-only group ANCHORS the
	// composer to that project — it never switches the app; the machine is
	// decided per chat, at submit.
	const onPickGroup = (group: LogicalProjectGroup) => {
		const member = preferredGroupMember(group);
		if (member === null) return;
		if (member.isActive) {
			setRemoteAnchor(null);
			void selectFolder(member.folderId);
			return;
		}
		setRemoteAnchor({ groupKey: group.key, member });
	};
	const onAdd = () => {
		void addFolder();
	};

	// "Create from…" pick. PR/branch → check out a worktree now (or reuse the
	// "In use" one) and remember its id; the first send binds the chat to it.
	// Issue → fetch its Markdown, prefill the composer with the title, and hold
	// the body to attach into the chat's `.context/files/` at submit.
	const handleCreateFromSelect = async (
		sel: CreateFromSelection,
	): Promise<void> => {
		if (selectedFolderId === null || creatingSource) return;
		setSubmitError(null);
		if (sel.kind === "linear") {
			const identifiers = sel.issues
				.map((issue) => issue.identifier)
				.join(", ");
			setCreateSource({
				kind: "linear",
				worktreeId: null,
				label: identifiers,
				issue: null,
				linear: { issues: sel.issues, mode: sel.mode },
			});
			const generated =
				sel.mode === "combined"
					? `Implement ${identifiers} together in one pull request. Work through every selected ticket and verify the combined result.`
					: `Implement each selected Linear ticket in its own session and pull request. Verify each ticket before completing it.`;
			useComposerBridge.getState().insertText?.(generated);
			return;
		}
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
					worktreeId: null,
					label: `#${sel.number}`,
					issue: { markdown: res.markdown, title: res.title || sel.title },
					linear: null,
				});
				// Prefill the composer with an editable default the user can rewrite.
				const insert = useComposerBridge.getState().insertText;
				if (insert !== null) insert(res.title || sel.title);
			} catch {
				setSubmitError(
					"Couldn't load that issue. Is the GitHub CLI (gh) signed in?",
				);
			}
			return;
		}
		// PR / branch: reuse an existing worktree when the row was "In use",
		// otherwise check one out now against that ref.
		const label =
			sel.kind === "pr" ? `PR #${sel.number} · ${sel.headRefName}` : sel.branch;
		if (sel.existingWorktreeId !== null) {
			setCreateSource({
				kind: sel.kind,
				worktreeId: sel.existingWorktreeId,
				label,
				issue: null,
				linear: null,
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
			worktreeId: wt.id,
			label,
			issue: null,
			linear: null,
		});
	};

	const prepareLinearInput = async (
		sessionId: SessionId,
		issues: ReadonlyArray<LinearIssueSummary>,
		input: ComposerInput,
	): Promise<ComposerInput> => {
		const { result: prepared } = await dispatchEnvironmentShellCommand<
			{
				readonly sessionId: SessionId;
				readonly issues: ReadonlyArray<{
					readonly workspaceId: string;
					readonly issueId: string;
					readonly identifier: string;
				}>;
			},
			{
				readonly files: ReadonlyArray<LinearContextFile>;
				readonly attachments: ReadonlyArray<AttachmentRef>;
				readonly warnings: ReadonlyArray<LinearContextWarning>;
			}
		>({
			environmentId: EnvironmentId.make(activeEnvironmentId),
			kind: "linear.prepareContext",
			commandId: CommandId.make(`linear-context:${crypto.randomUUID()}`),
			payload: {
				sessionId,
				issues: issues.map((issue) => ({
					workspaceId: issue.workspaceId,
					issueId: issue.issueId,
					identifier: issue.identifier,
				})),
			},
		});
		if (prepared.warnings.length > 0) {
			toastManager.add({
				type: "error",
				title: "Some Linear context was incomplete",
				description: prepared.warnings
					.map((warning) => warning.message)
					.join(" · "),
			});
		}
		return applyPreparedLinearContext(input, prepared);
	};

	// Driven by the real ChatComposer (draft mode): it hands back the parsed
	// input (file refs / attachments / skills / annotations intact) and whether
	// goal mode was on. We create the worktree + chat with the draft's chosen
	// provider/model/runtime/permission, carry the model options over, then send
	// as soon as the provider is ready. Worktree setup continues independently.
	const handleDraftSubmit = async (
		input: ComposerInput,
		opts: {
			readonly asGoal: boolean;
			readonly pendingAttachments: ReadonlyArray<PendingDraftAttachment>;
			readonly pendingContextFiles: ReadonlyArray<PendingDraftContextFile>;
		},
	): Promise<void> => {
		if (submitting) return;
		const draft = useSessionsStore.getState().draftSession;
		if (draft === null) return;
		if (selectedCloudProviderId !== null) {
			if (!CLOUD_WORKSPACE_BETA_AVAILABLE) return;
			if (cloudProject === null) {
				setSubmitError(
					"Connect this repository in Cloud Sandbox settings first.",
				);
				return;
			}
			if (draft.providerId !== "claude" && draft.providerId !== "codex") {
				setSubmitError("Cloud Sandbox currently supports Claude and Codex.");
				return;
			}
			if (
				opts.pendingAttachments.length > 0 ||
				opts.pendingContextFiles.length > 0 ||
				createSource !== null ||
				opts.asGoal
			) {
				setSubmitError(
					"Attachments, context files, goals, and Create-from aren't supported yet when starting a cloud workspace.",
				);
				return;
			}
			setSubmitError(null);
			setSubmitting(true);
			setPendingPrompt(
				input.text.trim().length > 0 ? input.text.trim() : "New chat",
			);
			setPendingCloudStatus("Creating cloud workspace…");
			try {
				const launch = await runControlPlane((control) =>
					control["cloud.workspaces.create"]({
						projectId: cloudProject.projectId,
						providerId: selectedCloudProviderId,
						baseRef: `origin/${cloudProject.defaultBranch}`,
						agent: draft.providerId,
						model: draft.model,
						credentialKinds: [draft.providerId as "claude" | "codex"],
						firstMessage: input.text,
						idempotencyKey: crypto.randomUUID(),
					}),
				);
				const title =
					input.text.trim().split(/\r?\n/u, 1)[0]?.slice(0, 80) ||
					launch.workspace.branch;
				const summary = summaryFromLaunch({
					workspace: launch.workspace,
					repositoryIdentity: cloudProject.repositoryIdentity,
					repositoryDisplayName: cloudProject.displayName,
					title,
					agent: draft.providerId,
					model: draft.model,
				});
				if (selectedFolderId === null)
					throw new Error("Select a repository before starting a cloud chat.");
				stageCloudChat(summary, selectedFolderId, input.text);
				useChatsStore.getState().select(summary.chatId);
				void ensureCloudWorkspaceAttached(summary).catch((cause) =>
					toastManager.add({
						type: "error",
						title: "Cloud workspace needs attention",
						description: formatError(cause),
					}),
				);
				useSessionsStore.getState().clearDraft();
				setSelectedCloudProviderId(null);
			} catch (cause) {
				setSubmitError(formatError(cause));
				setPendingPrompt(null);
			} finally {
				setPendingCloudStatus(null);
				setSubmitting(false);
			}
			return;
		}
		const target = resolvedTarget;
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
				target.folderId !== selectedFolderId)
				? { environmentId: target.environmentId, folderId: target.folderId }
				: null;
		if (remoteTarget !== null) {
			// Create the chat ON the target computer first, then open it. The
			// draft is consumed here, so nothing needs carrying across the
			// activation — and with desktop-anchored badges the sidebar does not
			// reorganize; the only visible effect is the chat opening.
			if (
				opts.pendingAttachments.length > 0 ||
				opts.pendingContextFiles.length > 0 ||
				createSource !== null ||
				opts.asGoal
			) {
				setSubmitError(
					"Attachments, context files, goals, and Create-from aren't supported yet when starting a chat on another computer.",
				);
				return;
			}
			setSubmitError(null);
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
			const switched = await switchToEnvironment({
				environmentId: remoteTarget.environmentId,
				folderId: remoteTarget.folderId,
				chatId: remoteResult.chatId,
				seed: remoteResult.remoteSeed,
			});
			useSessionsStore.getState().clearDraft();
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
		if (selectedFolderId === null) return;
		const startupInput = ComposerInput.make({ ...input, asGoal: opts.asGoal });
		const startupNeedsPreparation =
			createSource !== null ||
			opts.pendingAttachments.length > 0 ||
			opts.pendingContextFiles.length > 0;
		setSubmitError(null);
		setSubmitting(true);
		setPendingPrompt(
			input.text.trim().length > 0 ? input.text.trim() : "New chat",
		);
		if (
			createSource?.linear?.mode === "separate" &&
			createSource.linear.issues.length > 0
		) {
			const issues = createSource.linear.issues;
			const successes: Array<{
				chatId: ChatId;
				sessionId: SessionId;
			}> = [];
			const failures: string[] = [];
			let cursor = 0;
			const launchOne = async (issue: LinearIssueSummary) => {
				const result = await create(
					selectedFolderId,
					draft.providerId,
					draft.model,
					{
						title: `${issue.identifier} ${issue.title}`,
						runtimeMode: draft.runtimeMode,
						permissionMode: draft.permissionMode,
						workspacePolicy: resolveChatWorkspacePolicy(
							EnvironmentId.make(activeEnvironmentId),
							selectedFolderId,
						),
						workspaceRequested:
							defaultAutoCreateWorktree || repositoryAutoCreateWorktree,
						startupInput,
						startupReady: false,
					},
				);
				if (result === null) {
					failures.push(`${issue.identifier}: couldn't create session`);
					return;
				}
				migrateModelOptions(
					EnvironmentId.make(activeEnvironmentId),
					DRAFT_SESSION_ID,
					result.initialSessionId,
				);
				const startupQueueId = result.startupQueueId;
				successes.push({
					chatId: result.chatId,
					sessionId: result.initialSessionId,
				});
				try {
					const worktreeId = result.worktreeId;
					let ticketInput = await prepareLinearInput(
						result.initialSessionId,
						[issue],
						startupInput,
					);
					const uploadRoot =
						worktreeId === null
							? (selectedFolder?.path ?? null)
							: ((
									useWorktreesStore.getState().byProject[selectedFolderId] ??
									EMPTY_WORKTREES
								).find((worktree) => worktree.id === worktreeId)?.path ??
								selectedFolder?.path ??
								null);
					ticketInput = await finalizeDraftContextFiles(
						ticketInput,
						opts.pendingContextFiles,
						async (pending) => {
							const saved = await saveContextText({
								environmentId: EnvironmentId.make(activeEnvironmentId),
								sessionId: result.initialSessionId,
								text: pending.text,
								ext: pending.ext,
								...(uploadRoot ? { rootPath: uploadRoot } : {}),
							});
							return { relPath: saved.relPath, absPath: saved.absPath };
						},
					);
					ticketInput = await finalizeDraftAttachments(
						ticketInput,
						opts.pendingAttachments,
						(pending) =>
							uploadOne(
								result.initialSessionId,
								pending.file,
								uploadRoot ?? undefined,
							),
					);
					if (startupQueueId !== null) {
						await updateQueuedMessage(
							{
								environmentId: EnvironmentId.make(activeEnvironmentId),
								sessionId: result.initialSessionId,
							},
							startupQueueId,
							ticketInput,
						);
					}
				} catch (error) {
					failures.push(
						`${issue.identifier}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			};
			const workers = Array.from(
				{ length: Math.min(3, issues.length) },
				async () => {
					while (cursor < issues.length) {
						const issue = issues[cursor++];
						if (issue !== undefined) await launchOne(issue);
					}
				},
			);
			await Promise.all(workers);
			for (const pending of opts.pendingAttachments) {
				if (pending.previewUrl) URL.revokeObjectURL(pending.previewUrl);
			}
			if (failures.length > 0) {
				toastManager.add({
					type: "error",
					title: `${failures.length} Linear session${failures.length === 1 ? "" : "s"} failed`,
					description: failures.join(" · "),
				});
			}
			const first = successes[0];
			if (first === undefined) {
				setSubmitError("Couldn't start any of the selected Linear tickets.");
				setSubmitting(false);
				return;
			}
			useChatsStore.getState().select(first.chatId);
			useSessionsStore.getState().select(first.sessionId);
			setCreateSource(null);
			useSessionsStore.getState().clearDraft();
			return;
		}
		// A "Create from…" PR/branch already checked out (or reused) a worktree —
		// pin the chat to it. Otherwise fall back to the normal auto-worktree.
		const workspacePolicy: ChatWorkspacePolicy | Promise<ChatWorkspacePolicy> =
			createSource !== null && createSource.worktreeId !== null
				? { _tag: "existing", worktreeId: createSource.worktreeId }
				: resolveChatWorkspacePolicy(
						EnvironmentId.make(activeEnvironmentId),
						selectedFolderId,
					);
		const result = await create(
			selectedFolderId,
			draft.providerId,
			draft.model,
			{
				runtimeMode: draft.runtimeMode,
				permissionMode: draft.permissionMode,
				workspacePolicy,
				workspaceRequested:
					(createSource !== null && createSource.worktreeId !== null) ||
					defaultAutoCreateWorktree ||
					repositoryAutoCreateWorktree,
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
		if (
			useChatsStore.getState().pendingCreationByChat[result.chatId] !==
			undefined
		) {
			// An ambiguous transport interruption leaves the retry-safe chat command
			// in the outbox. The pending-creation surface owns the UI until replay
			// produces the durable chat/session; never issue session-scoped follow-up
			// commands against its provisional id.
			useSessionsStore.getState().clearDraft();
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
		// Issue source: write its Markdown into the chat's real worktree cwd and
		// attach it as an `@`-file so the agent reads it from its own cwd (works
		// for both the Claude `@relPath` and Codex `absPath` mention paths).
		let finalInput = startupInput;
		if (createSource?.issue != null) {
			const ref = await saveContextFile(
				EnvironmentId.make(activeEnvironmentId),
				sessionId,
				createSource.issue.markdown,
			);
			if (ref !== null) {
				finalInput = appendContextFileRef(startupInput, ref);
			}
		}
		if (createSource?.linear?.mode === "combined") {
			try {
				finalInput = await prepareLinearInput(
					sessionId,
					createSource.linear.issues,
					finalInput,
				);
			} catch (error) {
				toastManager.add({
					type: "error",
					title: "Linear context could not be fully prepared",
					description: error instanceof Error ? error.message : String(error),
				});
			}
		}
		const uploadRoot = (() => {
			if (worktreeId === null) return selectedFolder?.path ?? null;
			const wt = (
				useWorktreesStore.getState().byProject[selectedFolderId] ??
				EMPTY_WORKTREES
			).find((w) => w.id === worktreeId);
			return wt?.path ?? selectedFolder?.path ?? null;
		})();
		if (opts.pendingContextFiles.length > 0) {
			try {
				finalInput = await finalizeDraftContextFiles(
					finalInput,
					opts.pendingContextFiles,
					async (pending) => {
						const res = await saveContextText({
							environmentId: EnvironmentId.make(activeEnvironmentId),
							sessionId,
							text: pending.text,
							ext: pending.ext,
							...(uploadRoot ? { rootPath: uploadRoot } : {}),
						});
						return { relPath: res.relPath, absPath: res.absPath };
					},
				);
			} catch (err) {
				console.error("[chat-landing] deferred context file failed", err);
				setSubmitError("Couldn't attach pasted text. Please try again.");
				setPendingPrompt(null);
				setPendingWorktreeId(null);
				setSubmitting(false);
				return;
			}
		}
		if (opts.pendingAttachments.length > 0) {
			try {
				finalInput = await finalizeDraftAttachments(
					finalInput,
					opts.pendingAttachments,
					(pending) =>
						uploadOne(sessionId, pending.file, uploadRoot ?? undefined),
				);
			} catch (err) {
				console.error("[chat-landing] deferred upload failed", err);
				setSubmitError("Couldn't attach one of those files. Please try again.");
				setPendingPrompt(null);
				setPendingWorktreeId(null);
				setSubmitting(false);
				return;
			} finally {
				for (const pending of opts.pendingAttachments) {
					if (pending.previewUrl) URL.revokeObjectURL(pending.previewUrl);
				}
			}
		}
		if (startupQueueId !== null) {
			// Finalization is the release edge. If the provider became ready first,
			// this update requests a drain; if the user deleted the item meanwhile,
			// the server returns not-found and the item is never resurrected.
			await updateQueuedMessage(
				{ environmentId: EnvironmentId.make(activeEnvironmentId), sessionId },
				startupQueueId,
				finalInput,
			);
		}
		setCreateSource(null);
		useSessionsStore.getState().clearDraft();
	};

	// Bridge: covers the brief create() RPC window (worktree → chat) before the
	// session exists and MainShell swaps us for the real ChatView + composer.
	// Mirrors that layout — the unified setup card on top, the queued message
	// pinned at the bottom — so the handoff to the live card is seamless.
	if (submitting && pendingPrompt !== null) {
		const progress = chatLandingProgress({
			cloudStatus: pendingCloudStatus,
			hasPendingWorktree:
				pendingWorktreeId !== null ||
				defaultAutoCreateWorktree ||
				repositoryAutoCreateWorktree,
		});
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="min-h-0 flex-1 overflow-y-auto">
					{progress.kind === "cloud" ? (
						<div className="mx-auto mt-8 flex w-full max-w-2xl items-center gap-3 rounded-lg border border-border/60 bg-muted/30 px-4 py-3">
							<Spinner className="size-4" />
							<div className="min-w-0">
								<p className="text-sm font-medium">Starting Cloud Sandbox</p>
								<p className="text-xs text-muted-foreground">
									{progress.status}
								</p>
							</div>
						</div>
					) : null}
					{progress.kind === "worktree" ? (
						<SetupCardView
							data={{
								repoName: selectedFolder?.name ?? "this repo",
								hasWorktree:
									pendingWorktreeId !== null || defaultAutoCreateWorktree,
								worktreePending: pendingWorktree === null,
								worktreeName: pendingWorktree?.name ?? null,
								branch: pendingWorktree?.branch ?? null,
								baseBranch: pendingWorktree?.baseBranch ?? null,
								setupStatus: pendingWorktree?.setupStatus ?? null,
								setupOutput: pendingWorktree?.setupOutput ?? "",
								onRerun: null,
							}}
						/>
					) : null}
				</div>
				<div className="px-4 pb-4">
					<QueuedComposerPill prompt={pendingPrompt} count={1} />
				</div>
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10">
			<div className="flex w-full max-w-3xl flex-col gap-4">
				<h1 className="text-center text-xl font-medium text-foreground/90">
					{headline}
				</h1>

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
									: `${unavailableComputers.length} computers`}
							</span>{" "}
							{unavailableComputers.length === 1
								? "is unavailable."
								: "are unavailable."}{" "}
							Zuse will keep trying.
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
							{retryingEnvironmentId === null ? "Retry" : "Retrying…"}
						</button>
					</div>
				) : null}

				{pendingProjectSetup !== null ? (
					<div className="mx-auto flex w-full max-w-2xl items-center gap-3 rounded-lg border border-border bg-muted/45 px-3 py-2">
						<div className="min-w-0 flex-1">
							<p className="text-xs font-medium text-foreground">
								This project isn’t on {pendingProjectSetup.label}
							</p>
							<p className="text-[11px] text-muted-foreground">
								Clone it there before starting this chat.
							</p>
						</div>
						<button
							type="button"
							className="inline-flex min-h-8 shrink-0 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring"
							onClick={() => setProjectSetupOpen(true)}
						>
							Clone project
						</button>
					</div>
				) : null}

				{submitError !== null && (
					<div className="mx-auto flex w-full max-w-2xl items-start gap-2 rounded-lg border border-rose-400/30 bg-rose-500/[0.08] px-3 py-2 text-[12px] text-rose-200">
						<span className="mt-px shrink-0">⚠</span>
						<span className="flex-1 leading-snug">{submitError}</span>
						<button
							type="button"
							onClick={() => setSubmitError(null)}
							aria-label="Dismiss error"
							className="-mr-1 shrink-0 rounded p-0.5 text-rose-200/80 hover:bg-rose-500/[0.12] hover:text-rose-100"
						>
							<X className="size-3.5" strokeWidth={1.8} />
						</button>
					</div>
				)}

				{/* The REAL ChatComposer in draft mode — one source of truth for file
            tagging, model/thinking, fast mode, plan mode, runtime, etc. On
            send it hands the parsed input back to `handleDraftSubmit`. */}
				{draftSession !== null ? (
					<Suspense fallback={<div className="h-28" aria-busy="true" />}>
						<ChatComposer
							submitDisabled={pendingProjectSetup !== null}
							// Keyed by the draft's anchor — NOT by the "Run on" target,
							// so picking a computer never remounts the editor and the
							// typed text stays exactly where it is.
							key={
								remoteAnchor !== null
									? `remote:${remoteAnchor.member.environmentId}:${remoteAnchor.member.folderId}`
									: `${activeEnvironmentId}:${selectedFolderId ?? "none"}`
							}
							session={draftSession}
							environmentId={EnvironmentId.make(
								remoteAnchor?.member.environmentId ?? activeEnvironmentId,
							)}
							composerDraftKey={
								remoteAnchor !== null
									? composerDraftKeyForRemoteLanding(
											EnvironmentId.make(remoteAnchor.member.environmentId),
											remoteAnchor.member.folderId,
										)
									: composerDraftKeyForLanding(
											EnvironmentId.make(activeEnvironmentId),
											selectedFolderId,
										)
							}
							onDraftSubmit={(input, opts) =>
								void handleDraftSubmit(input, opts)
							}
							headerSlot={
								<div className="flex w-full items-center justify-between gap-2">
									<div className="flex min-w-0 items-center gap-1.5">
										<ProjectPicker
											groups={projectGroups}
											selectedFolderId={selectedFolderId}
											selectedName={
												anchoredGroup?.displayName ??
												selectedFolder?.name ??
												null
											}
											onPickGroup={onPickGroup}
											onAdd={onAdd}
										/>
										{desktopCatalogEnabled || cloudPickerItems.length > 0 ? (
											<ComputerPicker
												group={pickerGroup}
												target={resolvedTarget}
												entries={catalogEntries}
												onPickTarget={(target) => {
													setSelectedCloudProviderId(null);
													setTargetOverride(target);
												}}
												cloudItems={cloudPickerItems}
												selectedCloudProviderId={selectedCloudProviderId}
												onPickCloud={(providerId) => {
													if (cloudProject === null) {
														setSettingsSection({ kind: "machines" });
														setView("settings");
														return;
													}
													setTargetOverride(null);
													setSelectedCloudProviderId(providerId);
												}}
												onRetryEnvironment={retryComputer}
											/>
										) : null}
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
									</div>
									<div className="flex min-w-0 items-center gap-1.5">
										{createSource !== null && (
											<span className="flex min-w-0 items-center gap-1 overflow-x-auto">
												{createSource.linear !== null ? (
													createSource.linear.issues.map((issue) => (
														<span
															key={`${issue.workspaceId}:${issue.issueId}`}
															className="flex shrink-0 items-center gap-1 rounded-md bg-muted/60 py-1 pl-2 pr-1 text-[11px] text-muted-foreground"
														>
															<span>{issue.identifier}</span>
															<button
																type="button"
																aria-label={`Remove ${issue.identifier}`}
																onClick={() =>
																	setCreateSource((current) => {
																		if (
																			current?.linear === null ||
																			current === null
																		)
																			return current;
																		const issues = current.linear.issues.filter(
																			(candidate) =>
																				candidate.workspaceId !==
																					issue.workspaceId ||
																				candidate.issueId !== issue.issueId,
																		);
																		return issues.length === 0
																			? null
																			: {
																					...current,
																					label: issues
																						.map(
																							(candidate) =>
																								candidate.identifier,
																						)
																						.join(", "),
																					linear: { ...current.linear, issues },
																				};
																	})
																}
																className="rounded p-0.5 hover:bg-muted hover:text-foreground"
															>
																<X className="size-3" strokeWidth={2} />
															</button>
														</span>
													))
												) : createSource.kind === "issue" ? (
													<span>Issue {createSource.label} attached</span>
												) : (
													<span className="max-w-[16rem] truncate">
														{createSource.label}
													</span>
												)}
												{createSource.linear === null && (
													<button
														type="button"
														onClick={() => setCreateSource(null)}
														aria-label="Clear create-from source"
														className="shrink-0 rounded p-0.5 hover:bg-muted hover:text-foreground"
													>
														<X className="size-3" strokeWidth={2} />
													</button>
												)}
											</span>
										)}
										{creatingSource && (
											<Spinner className="size-3.5 text-muted-foreground" />
										)}
										{/* Create-from browses the ACTIVE environment's PRs and
										    branches — hidden for a remote-anchored draft. */}
										{remoteAnchor === null ? (
											<CreateFromMenu
												environmentId={EnvironmentId.make(activeEnvironmentId)}
												folderId={selectedFolderId}
												rootPath={selectedFolder?.path ?? ""}
												onSelect={(sel) => void handleCreateFromSelect(sel)}
											/>
										) : null}
									</div>
								</div>
							}
						/>
					</Suspense>
				) : (
					<p className="text-center text-sm text-muted-foreground">
						Pick a project below to start a new chat.
					</p>
				)}
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
	const [query, setQuery] = useState("");
	const visibleThreads = useMemo(
		() => filterImportThreads(threads, query),
		[query, threads],
	);
	return (
		<Menu
			onOpenChange={(open) => {
				if (open) onOpen();
				else setQuery("");
			}}
		>
			<MenuTrigger
				className="flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-accent data-[popup-open]:bg-accent"
				aria-label="Import an existing chat"
			>
				<HugeiconsIcon icon={ChatDownload01Icon} className="size-3.5" />
				<span>Import chat</span>
				<ChevronDown className="size-3 opacity-60" />
			</MenuTrigger>
			<MenuPopup side="bottom" align="start" className="w-80 p-1">
				<div className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">
					Recent provider chats
				</div>
				<div className="px-1 pb-1.5">
					<div className="flex h-8 items-center gap-2 rounded-md border border-border bg-background/50 px-2 focus-within:border-ring">
						<Search className="size-3.5 shrink-0 text-muted-foreground" />
						<input
							type="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							onKeyDown={(event) => event.stopPropagation()}
							placeholder="Search chats…"
							aria-label="Search imported chats"
							className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
						/>
					</div>
				</div>
				<div className="max-h-64 overflow-y-auto overscroll-contain">
					{loading && threads.length === 0 ? (
						<div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
							<Spinner className="size-3.5" />
							Finding chats…
						</div>
					) : error !== null && threads.length === 0 ? (
						<div className="px-2 py-2 text-xs text-destructive">
							Couldn’t load chats. Close and reopen this menu to retry.
						</div>
					) : threads.length === 0 ? (
						<div className="px-2 py-2 text-xs text-muted-foreground">
							No recent chats found.
						</div>
					) : visibleThreads.length === 0 ? (
						<div className="px-2 py-3 text-xs text-muted-foreground">
							No chats match “{query.trim()}”.
						</div>
					) : (
						visibleThreads.map((thread) => {
							const active = continuingId === thread.id;
							return (
								<MenuItem
									key={thread.id}
									disabled={!thread.available || continuingId !== null}
									onClick={() => onImport(thread)}
									className="grid min-h-11 grid-cols-[auto_1fr_auto] gap-x-2 px-2 py-1.5"
									title={
										thread.available
											? thread.projectPath
											: `${thread.projectPath || "Project folder"} is missing`
									}
								>
									<ProviderIcon
										providerId={thread.providerId}
										className="col-start-1 row-span-2 size-4 self-center"
									/>
									<span className="col-start-2 row-start-1 truncate text-xs font-medium">
										{thread.title}
									</span>
									<span className="col-start-2 row-start-2 truncate text-[10px] text-muted-foreground">
										{providerThreadLabel(thread.providerId)} ·{" "}
										{thread.projectName}
									</span>
									{active ? (
										<Spinner className="col-start-3 row-span-2 size-3.5 self-center" />
									) : (
										<span className="col-start-3 row-span-2 self-center text-[10px] text-muted-foreground">
											{thread.available
												? formatThreadRelative(thread.updatedAt)
												: "Missing"}
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
	return PROVIDER_LABEL[providerId] ?? providerId;
}

/**
 * Compact "queued first message" indicator shown in the landing bridge while
 * the worktree/chat is being created. Mirrors the queue chips the real
 * composer's `QueueTray` shows once the session exists, so the message reads
 * as held-not-sent throughout.
 */
function QueuedComposerPill({
	prompt,
	count,
}: {
	prompt: string;
	count: number;
}) {
	return (
		<div className="mx-auto w-full max-w-3xl">
			<div className="flex items-center gap-2 rounded-xl border border-border/50 bg-muted/15 px-3.5 py-2.5 text-[13px]">
				<Spinner className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="flex-1 truncate text-foreground/80">{prompt}</span>
				<span className="shrink-0 text-[11px] text-muted-foreground">
					{count} queued
				</span>
			</div>
		</div>
	);
}

function ProjectPicker({
	groups,
	selectedFolderId,
	selectedName,
	onPickGroup,
	onAdd,
}: {
	groups: ReadonlyArray<LogicalProjectGroup>;
	selectedFolderId: FolderId | null;
	selectedName: string | null;
	onPickGroup: (group: LogicalProjectGroup) => void;
	onAdd: () => void;
}) {
	return (
		<Menu>
			<MenuTrigger
				className="flex min-w-0 max-w-[16rem] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-accent data-[popup-open]:bg-accent"
				aria-label="Pick a project"
			>
				<HugeiconsIcon icon={Folder01Icon} className="size-3.5" />
				<span className="truncate">{selectedName ?? "Pick a project"}</span>
				<ChevronDown className="size-3 opacity-60" />
			</MenuTrigger>
			<MenuPopup side="bottom" align="start" className="w-64 p-1">
				{groups.length === 0 ? (
					<div className="px-2 py-1.5 text-xs text-muted-foreground">
						No projects yet.
					</div>
				) : (
					groups.map((group) => {
						const active = group.members.some(
							(member) =>
								member.isActive && member.folderId === selectedFolderId,
						);
						const disabled = preferredGroupMember(group) === null;
						return (
							<MenuItem
								key={group.key}
								disabled={disabled}
								onClick={() => onPickGroup(group)}
								className={cn(
									"grid grid-cols-[1rem_auto_1fr] items-center gap-x-2 rounded-md px-2 py-1.5 text-sm",
									active
										? "bg-accent/40 text-accent-foreground data-highlighted:bg-accent/60"
										: undefined,
								)}
							>
								<span className="col-start-1 row-start-1 flex items-center justify-center">
									{active && (
										<HugeiconsIcon
											icon={Tick01Icon}
											className="size-3.5 opacity-90"
										/>
									)}
								</span>
								<HugeiconsIcon
									icon={Folder01Icon}
									className="col-start-2 row-start-1 size-3.5 opacity-80"
								/>
								<span className="col-start-3 row-start-1 truncate">
									{group.displayName}
								</span>
							</MenuItem>
						);
					})
				)}
				<MenuSeparator />
				<MenuItem
					onClick={onAdd}
					className="grid grid-cols-[1rem_auto_1fr] items-center gap-x-2 rounded-md px-2 py-1.5 text-sm"
				>
					<span className="col-start-1 row-start-1" />
					<HugeiconsIcon
						icon={FolderAddIcon}
						className="col-start-2 row-start-1 size-3.5 opacity-80"
					/>
					<span className="col-start-3 row-start-1">Add new project</span>
				</MenuItem>
			</MenuPopup>
		</Menu>
	);
}
