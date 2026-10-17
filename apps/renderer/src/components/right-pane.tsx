import { isHostedProduct } from "../lib/hosted-session.ts";
import { useSimulatorReveal } from "../lib/simulator-client-bus.ts";
import { SimulatorPane } from "./simulator/simulator-pane.tsx";
import { WorkspacePanelTab } from "./workspace-panel-tab.tsx";
import "@zuse/i18n/english/chat";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ChatRef, ExecutionRef } from "@zuse/client-runtime/resource-ref";
import {
	EnvironmentId,
	type Folder,
	type FolderId,
	type WorktreeId,
} from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	CheckListIcon,
	CloudIcon,
	ComputerIcon,
	ComputerTerminal01Icon,
	Folder01Icon,
	GitCompareIcon,
	GitPullRequestIcon,
	GlobeIcon,
	MagicWand01Icon,
	SmartPhone02Icon,
} from "@zuse/icons/solid-rounded";
import { latestProposedPlanMarkdown } from "@zuse/utils/proposed-plan";
import { Plus } from "lucide-react";
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
	cloudSyncLocalPath,
	enableCloudSync,
} from "../lib/cloud-sync-client-bus.ts";
import { cloudSummaryForChat } from "../lib/cloud-workspace-catalog.ts";
import { ensureCloudWorkspaceAttached } from "../lib/cloud-workspaces.ts";
import { makeCommittedAuthority } from "../lib/committed-authority.ts";
import {
	useActiveSessionById,
	useEnvironmentChat,
} from "../lib/environment-entity-hooks.ts";
import { useEnvironmentShellResource } from "../lib/environment-shell-client-bus.ts";
import {
	useGitPrDetailsResource,
	useGitWorkspaceResource,
} from "../lib/git-workspace-client-bus.ts";
import { rendererPlatformCapabilities } from "../lib/platform-capabilities.ts";
import {
	restoreOrAddRightTerminal,
	wakeAndRestoreCloudRightTerminal,
} from "../lib/right-terminal-controller.ts";
import { getLocalEnvironmentId } from "../lib/rpc-client.ts";
import { isSessionTurnActive } from "../lib/session-runtime-state.ts";
import { useOptionalRendererSessionTimeline } from "../lib/session-timeline-hooks.ts";
import { formatShortcut } from "../lib/shortcuts.ts";
import {
	hydrateRightTerminalCatalog,
	invalidateTerminalCatalog,
} from "../lib/terminal-catalog.ts";
import {
	terminalOwnerLimitMessageFor,
	terminalOwnerLimitReached,
} from "../lib/terminal-policy.ts";
import { useAutoAnimate } from "../lib/use-auto-animate.ts";
import { useActiveContext } from "../store/active-workspace.ts";
import { useChatsStore } from "../store/chats.ts";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { useRegisterPane } from "../store/pane-focus.ts";
import { useSessionsStore } from "../store/sessions.ts";
import {
	EMPTY_TERMINALS,
	terminalOwnerId,
	terminalsKey,
	useTerminalsStore,
} from "../store/terminals.ts";
import {
	EMPTY_PANELS,
	type PanelInstance,
	type PanelKind,
	rightPaneKey,
	SINGLETON_PANEL_KINDS,
	useUiStore,
} from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { DiffPane } from "./diff-pane.tsx";
import { FileTree } from "./file-tree.tsx";
import { MarkdownBody } from "./markdown-body.tsx";
import { PrPane } from "./pr-pane.tsx";
import { SubagentsPane } from "./subagents-pane.tsx";
import { TerminalSlotPane, TerminalTabControls } from "./terminal-pane.tsx";
import { CompactEmptyState } from "./ui/compact-empty-state.tsx";
import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuShortcut,
	MenuTrigger,
} from "./ui/menu.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

const BrowserPaneHost = lazy(() =>
	import("./browser-pane.tsx").then((module) => ({
		default: module.BrowserPaneHost,
	})),
);

/**
 * The right pane has two folder identities for a cloud chat: the logical
 * desktop project used to render project UI, and the sandbox checkout used by
 * live RPCs. Cloud-only chats can have no local project; use their connected
 * environment's project without inventing a local folder.
 */
export const logicalRightPaneProject = (
	folders: ReadonlyArray<Folder>,
	selectedFolderId: FolderId | null,
	executionFolder: Folder | null = null,
): Folder | null =>
	folders.find((folder) => folder.id === selectedFolderId) ?? executionFolder;

const PANEL_META: Record<
	PanelKind,
	{
		readonly label: string;
		readonly icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
		readonly shortcut?: string;
	}
> = {
	files: {
		get label() {
			return uiMessage("chat:right_pane_files");
		},
		icon: Folder01Icon,
	},
	terminal: {
		get label() {
			return uiMessage("chat:right_pane_terminal");
		},
		icon: ComputerTerminal01Icon,
		shortcut: formatShortcut("toggle-terminal"),
	},
	changes: {
		get label() {
			return uiMessage("chat:right_pane_changes");
		},
		icon: GitCompareIcon,
	},
	pr: {
		get label() {
			return uiMessage("chat:right_pane_pr");
		},
		icon: GitPullRequestIcon,
	},
	plan: {
		get label() {
			return uiMessage("chat:right_pane_plan");
		},
		icon: CheckListIcon,
	},
	device: { label: "Simulator", icon: SmartPhone02Icon },
	browser: {
		get label() {
			return uiMessage("chat:right_pane_browser");
		},
		icon: GlobeIcon,
	},
	subagents: {
		get label() {
			return uiMessage("chat:right_pane_subagents");
		},
		icon: MagicWand01Icon,
	},
};

export const canUseChatPanel = (
	kind: PanelKind,
	readOnly: boolean,
	projectless = false,
): boolean =>
	(!projectless || (kind !== "pr" && kind !== "changes")) &&
	(!readOnly || kind === "files" || kind === "plan");

const LIVE_PANEL_KINDS = new Set<PanelKind>([
	"files",
	"terminal",
	"changes",
	"pr",
	"browser",
	"device",
]);

const PRIMARY_PANEL_ORDER: ReadonlyArray<PanelKind> = [
	"files",
	"pr",
	"changes",
	"terminal",
	"browser",
	"device",
];

const latestAssistantText = (
	messages: ReadonlyArray<import("@zuse/contracts").Message>,
): string | null => {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const content = messages[index]?.content;
		if (content?._tag !== "assistant") continue;
		const text = content.text.trim();
		return text.length > 0 ? text : null;
	}
	return null;
};

function addableKinds(
	panels: ReadonlyArray<PanelInstance>,
): ReadonlyArray<PanelKind> {
	const openSingletons = new Set(
		panels.filter((p) => SINGLETON_PANEL_KINDS.has(p.kind)).map((p) => p.kind),
	);
	return PRIMARY_PANEL_ORDER.filter(
		(k) => k === "terminal" || !openSingletons.has(k),
	);
}

type CloudTerminalActions = Readonly<{
	onAddCloud: () => void;
	onAddLocal: () => void;
	cloudDisabledReason: string | null;
	localDisabledReason: string | null;
}>;

type TerminalCatalogTarget = "cloud" | "local" | "project";

type CanonicalRootWaiter = Readonly<{
	chatKey: string | null;
	resolve: (rootPath: string) => void;
	reject: (cause: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}>;

const CANONICAL_ROOT_TIMEOUT_MS = 15_000;

const panelChoices = (
	kind: PanelKind,
	cloudTerminals: CloudTerminalActions | null,
	onAdd: (kind: PanelKind) => void,
	projectTerminalDisabledReason: string | null,
) => {
	if (kind === "terminal" && cloudTerminals !== null)
		return [
			{
				key: "cloud-terminal",
				label: uiMessage("chat:right_pane_cloud_terminal"),
				icon: CloudIcon,
				onClick: cloudTerminals.onAddCloud,
				disabledReason: cloudTerminals.cloudDisabledReason,
			},
			{
				key: "local-terminal",
				label: uiMessage("chat:right_pane_local_terminal"),
				icon: ComputerIcon,
				onClick: cloudTerminals.onAddLocal,
				disabledReason: cloudTerminals.localDisabledReason,
			},
		].filter((choice) => !isHostedProduct() || choice.key !== "local-terminal");
	const meta = PANEL_META[kind];
	return [
		{
			key: kind,
			label: meta.label,
			icon: meta.icon,
			onClick: () => onAdd(kind),
			disabledReason:
				kind === "terminal" ? projectTerminalDisabledReason : null,
		},
	];
};

/**
 * Right-pane dock. The panel set is user-managed: nothing is shown until the
 * user adds a panel from the launcher (empty state) or the trailing "+" menu.
 * Terminal can be added multiple times (each its own tab); Files / Changes /
 * PR / Browser are singletons. All open panels mount once and stay mounted
 * (`hidden` toggling) so switching tabs preserves terminal scrollback,
 * file-tree expansion, the browser webview, and any in-flight PR fetch.
 */
export function RightPane({
	directoryUnavailable = false,
	visible = true,
}: {
	directoryUnavailable?: boolean;
	visible?: boolean;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common"]);

	const paneRef = useRef<HTMLElement>(null);
	useRegisterPane("rightPane", paneRef);
	const ctx = useActiveContext();
	const folders = useWorkspaceStore((s) => s.folders);
	const logicalSelectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
	const executionFolderId = ctx.status === "ready" ? ctx.folderId : null;
	const executionRootPath = ctx.status === "ready" ? ctx.rootPath : null;
	const worktreeId = ctx.status === "ready" ? ctx.worktreeId : null;
	const executionRef = useMemo<ExecutionRef | null>(
		() =>
			ctx.status !== "ready"
				? null
				: {
						environmentId: ctx.environmentId,
						folderId: ctx.folderId,
						worktreeId: ctx.worktreeId,
						rootPath: ctx.rootPath,
					},
		[ctx, uiMessage],
	);
	const shell = useEnvironmentShellResource(
		executionRef?.environmentId ?? null,
	);
	const selected = logicalRightPaneProject(
		folders,
		logicalSelectedFolderId,
		shell.data?.folders.find((folder) => folder.id === executionFolderId) ??
			null,
	);
	const scratch = selected?.kind === "scratch";
	const workspaceView = useGitWorkspaceResource(
		scratch ? null : executionRef,
		"connect",
	);
	const prDetailsView = useGitPrDetailsResource(
		scratch ? null : executionRef,
		"cache-only",
	);
	const status = workspaceView.data?.status ?? null;
	const pr = workspaceView.data?.pr ?? null;
	const details = prDetailsView.data?.details ?? null;

	const chatId = useChatsStore((s) => s.selectedChatId);
	const catalogEnvironmentId = EnvironmentId.make(
		useEnvironmentCatalogStore((state) => state.activeEnvironmentId),
	);
	const cloudSummaryCandidate =
		chatId === null ? null : cloudSummaryForChat(chatId);
	const chatRef = useMemo<ChatRef | null>(() => {
		if (chatId === null) return null;
		return {
			environmentId:
				ctx.status === "ready"
					? ctx.environmentId
					: ctx.status === "cloud-unavailable"
						? EnvironmentId.make(ctx.workspaceId)
						: catalogEnvironmentId,
			chatId,
		};
	}, [catalogEnvironmentId, chatId, ctx, uiMessage]);
	const terminalCatalogEnvironmentId = chatRef?.environmentId ?? null;
	const terminalCatalogChatId = chatRef?.chatId ?? null;
	const localTerminalEnvironmentId = EnvironmentId.make(
		getLocalEnvironmentId(),
	);
	const activeContextStatus = ctx.status;
	useEffect(() => {
		if (
			terminalCatalogEnvironmentId === null ||
			terminalCatalogChatId === null ||
			directoryUnavailable ||
			activeContextStatus === "loading" ||
			activeContextStatus === "empty"
		) {
			return;
		}
		const catalogRef = {
			environmentId: terminalCatalogEnvironmentId,
			chatId: terminalCatalogChatId,
		} as const;
		const includeOwnerEnvironment = activeContextStatus !== "cloud-unavailable";
		void hydrateRightTerminalCatalog(catalogRef, localTerminalEnvironmentId, {
			includeOwnerEnvironment,
			includeLocalEnvironment: !isHostedProduct(),
		}).catch(() => undefined);
		return () => {
			invalidateTerminalCatalog(
				catalogRef,
				"right",
				localTerminalEnvironmentId,
			);
			if (
				includeOwnerEnvironment &&
				terminalCatalogEnvironmentId !== localTerminalEnvironmentId
			) {
				invalidateTerminalCatalog(
					catalogRef,
					"right",
					terminalCatalogEnvironmentId,
				);
			}
		};
	}, [
		activeContextStatus,
		directoryUnavailable,
		localTerminalEnvironmentId,
		terminalCatalogChatId,
		terminalCatalogEnvironmentId,
	]);
	const readOnly = useEnvironmentChat(chatRef)?.readOnly === true;
	const cloudSummary =
		cloudSummaryCandidate?.workspaceId === chatRef?.environmentId
			? cloudSummaryCandidate
			: null;
	const chatKey = chatRef === null ? null : rightPaneKey(chatRef);
	const sessionId = useSessionsStore((s) => s.selectedSessionId);
	const session = useActiveSessionById(sessionId);
	const timeline = useOptionalRendererSessionTimeline(
		sessionId,
		"connect",
		chatRef?.environmentId ?? null,
	);
	const messages = timeline.messages;
	const isRunning = session !== null && isSessionTurnActive(timeline.runtime);
	const planMarkdown = useMemo(
		() =>
			latestProposedPlanMarkdown(messages) ??
			(session?.providerId === "codex" &&
			session.permissionMode === "plan" &&
			!isRunning
				? latestAssistantText(messages)
				: null),
		[
			isRunning,
			messages,
			session?.permissionMode,
			session?.providerId,
			uiMessage,
		],
	);

	const termList = useTerminalsStore((s) =>
		chatRef
			? (s.byKey[terminalsKey(chatRef)] ?? EMPTY_TERMINALS)
			: EMPTY_TERMINALS,
	);
	const rightTerminalOwnerId =
		chatRef === null ? null : terminalOwnerId(chatRef, "right");
	const cloudTerminalLimitReached =
		chatRef !== null &&
		rightTerminalOwnerId !== null &&
		terminalOwnerLimitReached(
			termList,
			chatRef.environmentId,
			rightTerminalOwnerId,
		);
	const localTerminalLimitReached =
		rightTerminalOwnerId !== null &&
		terminalOwnerLimitReached(
			termList,
			localTerminalEnvironmentId,
			rightTerminalOwnerId,
		);
	const terminalActionRef = useRef<symbol | null>(null);
	const activeChatKeyAuthorityRef = useRef(makeCommittedAuthority(chatKey));
	const canonicalRootPathAuthorityRef = useRef(
		makeCommittedAuthority(executionRootPath),
	);
	useLayoutEffect(() => {
		activeChatKeyAuthorityRef.current.commit(chatKey);
		canonicalRootPathAuthorityRef.current.commit(executionRootPath);
	}, [chatKey, executionRootPath]);
	const canonicalRootWaitersRef = useRef(new Set<CanonicalRootWaiter>());
	const [terminalAction, setTerminalAction] =
		useState<TerminalCatalogTarget | null>(null);
	const [terminalCatalogError, setTerminalCatalogError] = useState<Readonly<{
		target: TerminalCatalogTarget;
		message: string;
		detail: string;
	}> | null>(null);
	useEffect(() => {
		terminalActionRef.current = null;
		setTerminalAction(null);
		setTerminalCatalogError(null);
		for (const waiter of canonicalRootWaitersRef.current) {
			if (waiter.chatKey === chatKey) continue;
			clearTimeout(waiter.timeout);
			canonicalRootWaitersRef.current.delete(waiter);
			waiter.reject(new Error("Terminal action moved to another chat"));
		}
	}, [chatKey]);
	useEffect(() => {
		if (executionRootPath === null) return;
		for (const waiter of canonicalRootWaitersRef.current) {
			if (waiter.chatKey !== chatKey) continue;
			clearTimeout(waiter.timeout);
			canonicalRootWaitersRef.current.delete(waiter);
			waiter.resolve(executionRootPath);
		}
	}, [chatKey, executionRootPath]);
	useEffect(
		() => () => {
			for (const waiter of canonicalRootWaitersRef.current) {
				clearTimeout(waiter.timeout);
				waiter.reject(new Error("Terminal surface was unmounted"));
			}
			canonicalRootWaitersRef.current.clear();
		},
		[],
	);

	const simulatorState = useSimulatorReveal(
		chatRef,
		executionRef?.environmentId ?? null,
	);
	const panels = useUiStore((s) =>
		chatKey ? (s.rightPanelsByChat[chatKey] ?? EMPTY_PANELS) : EMPTY_PANELS,
	);
	const activeId = useUiStore((s) =>
		chatKey ? (s.activeRightPanelByChat[chatKey] ?? null) : null,
	);
	const addPanel = useUiStore((s) => s.addPanel);
	const closePanel = useUiStore((s) => s.closePanel);
	const setActive = useUiStore((s) => s.setActiveRightPanel);
	const openChanges = useUiStore((s) => s.openChanges);
	const requestCloudAttachment = () => {
		if (cloudSummary !== null)
			void ensureCloudWorkspaceAttached(cloudSummary).catch(() => {});
	};
	const beginTerminalAction = (
		target: TerminalCatalogTarget,
	): symbol | null => {
		if (terminalActionRef.current !== null) return null;
		const token = Symbol(target);
		terminalActionRef.current = token;
		setTerminalAction(target);
		setTerminalCatalogError(null);
		return token;
	};
	const finishTerminalAction = (token: symbol): void => {
		if (terminalActionRef.current !== token) return;
		terminalActionRef.current = null;
		setTerminalAction(null);
	};
	const isCurrentTerminalAction = (
		token: symbol,
		expectedChatKey: string | null,
	): boolean =>
		terminalActionRef.current === token &&
		activeChatKeyAuthorityRef.current.isCurrent(expectedChatKey);
	const reportTerminalCatalogFailure = (
		target: TerminalCatalogTarget,
		cause: unknown,
	): void => {
		setTerminalCatalogError({
			target,
			message: `Could not restore ${target} terminals.`,
			detail: cause instanceof Error ? cause.message : String(cause),
		});
	};
	const waitForCanonicalRootPath = (
		expectedChatKey: string | null,
	): Promise<string> => {
		if (!activeChatKeyAuthorityRef.current.isCurrent(expectedChatKey)) {
			return Promise.reject(new Error("Terminal action moved to another chat"));
		}
		const current = canonicalRootPathAuthorityRef.current.current();
		if (current !== null) return Promise.resolve(current);
		return new Promise<string>((resolve, reject) => {
			const waiter = {
				chatKey: expectedChatKey,
				resolve,
				reject,
				timeout: setTimeout(() => {
					canonicalRootWaitersRef.current.delete(waiter);
					reject(new Error("Cloud workspace root did not become available"));
				}, CANONICAL_ROOT_TIMEOUT_MS),
			} satisfies CanonicalRootWaiter;
			canonicalRootWaitersRef.current.add(waiter);
		});
	};
	const handleAddPanel = (kind: PanelKind) => {
		if (!canUseChatPanel(kind, readOnly, scratch)) return;
		if (kind === "terminal") {
			handleAddProjectTerminal();
			return;
		}
		if (chatRef === null) return;
		addPanel(chatRef, kind);
		if (LIVE_PANEL_KINDS.has(kind)) requestCloudAttachment();
	};
	const handleAddProjectTerminal = () => {
		const token = beginTerminalAction("project");
		if (token === null) return;
		const expectedChatKey = chatKey;
		void (async () => {
			try {
				if (chatRef === null || selected === null) {
					throw new Error("Select a project chat first");
				}
				const result = await restoreOrAddRightTerminal({
					ref: chatRef,
					environmentId: chatRef.environmentId,
					cwd: executionRootPath ?? selected.path,
					isCurrent: () => isCurrentTerminalAction(token, expectedChatKey),
				});
				if (!isCurrentTerminalAction(token, expectedChatKey)) return;
				if (result.status === "failed") {
					reportTerminalCatalogFailure("project", result.cause);
				}
			} catch (cause) {
				if (isCurrentTerminalAction(token, expectedChatKey)) {
					reportTerminalCatalogFailure("project", cause);
				}
			} finally {
				finishTerminalAction(token);
			}
		})();
	};
	const handleAddCloudTerminal = () => {
		const token = beginTerminalAction("cloud");
		if (token === null) return;
		const expectedChatKey = chatKey;
		void (async () => {
			try {
				if (chatRef === null || cloudSummary === null) {
					throw new Error("Cloud workspace is unavailable for this chat");
				}
				const result = await wakeAndRestoreCloudRightTerminal({
					ref: chatRef,
					title: "Cloud",
					getCanonicalRootPath: () =>
						canonicalRootPathAuthorityRef.current.current(),
					waitForCanonicalRootPath: () =>
						waitForCanonicalRootPath(expectedChatKey),
					ensureAttached: () => ensureCloudWorkspaceAttached(cloudSummary),
					isCurrent: () => isCurrentTerminalAction(token, expectedChatKey),
				});
				if (!isCurrentTerminalAction(token, expectedChatKey)) return;
				if (result.status === "failed") {
					reportTerminalCatalogFailure("cloud", result.cause);
					return;
				}
				if (result.status === "cancelled") return;
			} catch (cause) {
				if (isCurrentTerminalAction(token, expectedChatKey)) {
					reportTerminalCatalogFailure("cloud", cause);
				}
			} finally {
				finishTerminalAction(token);
			}
		})();
	};
	const handleAddLocalTerminal = () => {
		if (isHostedProduct()) return;
		const token = beginTerminalAction("local");
		if (token === null) return;
		const expectedChatKey = chatKey;
		void (async () => {
			try {
				if (chatRef === null || cloudSummary === null) {
					throw new Error("Local sync is unavailable for this chat");
				}
				const localPath = await cloudSyncLocalPath(cloudSummary.workspaceId);
				if (!isCurrentTerminalAction(token, expectedChatKey)) {
					return;
				}
				if (localPath === null) {
					throw new Error("Local synced checkout is unavailable");
				}
				const result = await restoreOrAddRightTerminal({
					ref: chatRef,
					environmentId: localTerminalEnvironmentId,
					cwd: localPath,
					title: "Local",
					isCurrent: () => isCurrentTerminalAction(token, expectedChatKey),
				});
				if (!isCurrentTerminalAction(token, expectedChatKey)) return;
				if (result.status === "failed") {
					reportTerminalCatalogFailure("local", result.cause);
					return;
				}
				if (result.status === "cancelled") return;
				void enableCloudSync(cloudSummary.workspaceId);
			} catch (cause) {
				if (isCurrentTerminalAction(token, expectedChatKey)) {
					reportTerminalCatalogFailure("local", cause);
				}
			} finally {
				finishTerminalAction(token);
			}
		})();
	};
	const addablePanels = addableKinds(panels)
		.filter(
			(kind) =>
				kind !== "browser" || rendererPlatformCapabilities().integratedBrowser,
		)
		.filter((kind) => canUseChatPanel(kind, readOnly, scratch))
		.filter(
			(kind) =>
				!directoryUnavailable ||
				(kind !== "files" &&
					(kind !== "terminal" || cloudSummary !== null) &&
					kind !== "changes"),
		);

	const dockTabsRef = useAutoAnimate<HTMLDivElement>();

	const visiblePanels = panels.filter(
		(panel) =>
			canUseChatPanel(panel.kind, readOnly, scratch) &&
			(!isHostedProduct() ||
				panel.kind !== "terminal" ||
				termList[panel.slot]?.environmentId !== localTerminalEnvironmentId) &&
			(panel.kind !== "plan" || planMarkdown !== null) &&
			(panel.kind !== "browser" ||
				rendererPlatformCapabilities().integratedBrowser),
	);
	const effectiveActiveId =
		activeId !== null && visiblePanels.some((p) => p.id === activeId)
			? activeId
			: (visiblePanels[0]?.id ?? null);

	const handleClose = (panel: PanelInstance) => {
		if (panel.kind === "terminal" && chatRef !== null) {
			const key = terminalsKey(chatRef);
			const inst = (useTerminalsStore.getState().byKey[key] ?? EMPTY_TERMINALS)[
				panel.slot
			];
			if (inst !== undefined) {
				useTerminalsStore.getState().remove(chatRef, inst.id);
			}
		}
		if (chatRef !== null) closePanel(chatRef, panel.id);
	};

	const tabLabel = (panel: PanelInstance): string =>
		panel.kind === "terminal"
			? (termList[panel.slot]?.title ?? PANEL_META.terminal.label)
			: panel.kind === "device" && panel.deviceId
				? (simulatorState?.devices.find(
						(device) => device.id === panel.deviceId,
					)?.name ?? PANEL_META.device.label)
				: PANEL_META[panel.kind].label;

	const tabBadge = (panel: PanelInstance): React.ReactNode => {
		if (panel.kind === "changes") {
			return renderChangesBadge(status?.dirtyFiles ?? 0);
		}
		if (panel.kind === "pr") return renderPrBadge(pr, details);
		return null;
	};

	if (selected === null) {
		return (
			<aside
				aria-label={uiMessage("chat:workspace_panels")}
				className="flex h-full min-h-0 w-full flex-col"
			>
				<p className="px-3 py-6 text-center text-xs text-muted-foreground">
					{uiMessage("chat:right_pane_no_project_selected")}
				</p>
			</aside>
		);
	}

	const activePanel =
		visiblePanels.find((p) => p.id === effectiveActiveId) ?? null;
	const browserActive = activePanel?.kind === "browser";
	const browserAvailable =
		!readOnly && rendererPlatformCapabilities().integratedBrowser;
	const cloudTerminalActions =
		cloudSummary === null
			? null
			: {
					onAddCloud: handleAddCloudTerminal,
					onAddLocal: () => void handleAddLocalTerminal(),
					cloudDisabledReason:
						terminalAction !== null
							? "Another terminal action is already in progress."
							: cloudTerminalLimitReached
								? terminalOwnerLimitMessageFor(
										chatRef.environmentId,
										rightTerminalOwnerId,
									)
								: null,
					localDisabledReason:
						terminalAction !== null
							? "Another terminal action is already in progress."
							: localTerminalLimitReached
								? terminalOwnerLimitMessageFor(
										localTerminalEnvironmentId,
										rightTerminalOwnerId,
									)
								: null,
				};
	const projectTerminalDisabledReason =
		cloudSummary !== null
			? null
			: chatRef === null
				? "Select a chat first."
				: terminalAction !== null
					? "Another terminal action is already in progress."
					: cloudTerminalLimitReached
						? terminalOwnerLimitMessageFor(
								chatRef.environmentId,
								rightTerminalOwnerId,
							)
						: null;
	const addPanelMenu = (
		<AddPanelMenu
			addable={addablePanels}
			onAdd={handleAddPanel}
			cloudTerminals={cloudTerminalActions}
			projectTerminalDisabledReason={projectTerminalDisabledReason}
		/>
	);

	return (
		<aside
			ref={paneRef}
			aria-label={uiMessage("chat:workspace_panels")}
			data-pane="rightPane"
			tabIndex={-1}
			className="flex h-full min-h-0 w-full flex-col outline-none"
		>
			{visiblePanels.length > 0 ? (
				<div
					ref={dockTabsRef}
					className="workspace-panel-tabs flex shrink-0 items-center gap-0.5 overflow-x-auto text-[11px]"
				>
					{visiblePanels.map((panel) => {
						const terminal =
							panel.kind === "terminal" ? termList[panel.slot] : undefined;
						return (
							<WorkspacePanelTab
								key={panel.id}
								active={panel.id === effectiveActiveId}
								icon={PANEL_META[panel.kind].icon}
								label={tabLabel(panel)}
								closeLabel={uiMessage("chat:right_pane_close", {
									label: tabLabel(panel),
								})}
								badge={tabBadge(panel)}
								actions={
									chatRef !== null && terminal !== undefined ? (
										<TerminalTabControls
											chatRef={chatRef}
											instance={terminal}
											placement="right"
										/>
									) : null
								}
								onSelect={() => {
									if (chatRef !== null) setActive(chatRef, panel.id);
									if (LIVE_PANEL_KINDS.has(panel.kind))
										requestCloudAttachment();
									if (panel.kind === "changes") openChanges();
								}}
								onClose={() => handleClose(panel)}
							/>
						);
					})}
					{addPanelMenu}
				</div>
			) : null}
			{terminalAction !== null ? (
				<div
					role="status"
					className="flex h-7 shrink-0 items-center px-2 text-[11px] text-muted-foreground"
				>
					{uiMessage(
						terminalAction === "cloud"
							? "chat:terminal_restoring_cloud"
							: terminalAction === "local"
								? "chat:terminal_restoring_local"
								: "chat:terminal_restoring_project",
					)}
				</div>
			) : terminalCatalogError !== null ? (
				<div
					role="alert"
					title={terminalCatalogError.detail}
					className="flex h-7 shrink-0 items-center gap-2 px-2 text-[11px] text-muted-foreground"
				>
					<span className="min-w-0 flex-1 truncate">
						{terminalCatalogError.message}
					</span>
					<button
						type="button"
						className="h-7 rounded bg-muted px-2 text-foreground hover:bg-muted/80"
						onClick={
							terminalCatalogError.target === "cloud"
								? handleAddCloudTerminal
								: terminalCatalogError.target === "local"
									? handleAddLocalTerminal
									: handleAddProjectTerminal
						}
					>
						{uiMessage("common:retry")}
					</button>
				</div>
			) : null}
			<div className="workspace-panel-body flex min-h-0 min-w-0 flex-1 flex-col">
				{visiblePanels.length === 0 ? (
					<PanelLauncher
						actions={addPanelMenu}
						addable={addablePanels}
						onAdd={handleAddPanel}
						cloudTerminals={cloudTerminalActions}
						projectTerminalDisabledReason={projectTerminalDisabledReason}
					/>
				) : null}

				{ctx.status === "worktree-pending" && visiblePanels.length > 0 ? (
					<div
						className="flex min-h-0 flex-1 items-center justify-center px-4 text-xs text-muted-foreground"
						aria-busy="true"
					>
						{uiMessage("chat:right_pane_preparing_workspace")}
					</div>
				) : null}
				{ctx.status !== "worktree-pending" &&
					visiblePanels
						.filter((panel) => panel.kind !== "browser")
						.map((panel) => (
							<div
								key={panel.id}
								hidden={panel.id !== effectiveActiveId}
								className="flex min-h-0 min-w-0 flex-1 flex-col"
							>
								<PanelBody
									executionReady={
										ctx.status === "ready" && !directoryUnavailable
									}
									panel={panel}
									active={visible && panel.id === effectiveActiveId}
									folderId={executionFolderId ?? selected.id}
									projectId={selected.id}
									environmentId={
										executionRef?.environmentId ??
										chatRef?.environmentId ??
										catalogEnvironmentId
									}
									chatRef={chatRef}
									rootPath={executionRootPath ?? selected.path}
									worktreeId={worktreeId}
									cloudUnavailable={ctx.status === "cloud-unavailable"}
									localTerminal={
										panel.kind === "terminal" &&
										termList[panel.slot]?.environmentId ===
											getLocalEnvironmentId()
									}
									sessionId={sessionId}
									planMarkdown={planMarkdown}
									directoryUnavailable={directoryUnavailable}
								/>
							</div>
						))}

				{browserAvailable && ctx.status !== "cloud-unavailable" ? (
					<Suspense
						fallback={<div className="min-h-0 flex-1" aria-busy="true" />}
					>
						<BrowserPaneHost
							activeChatRef={chatRef}
							browserActive={browserActive}
						/>
					</Suspense>
				) : (
					<div
						hidden={!browserActive}
						className="flex min-h-0 min-w-0 flex-1 flex-col"
					>
						<div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
							<div className="max-w-sm">
								<h2 className="font-medium text-sm">
									{uiMessage(
										"chat:right_pane_integrated_browser_is_desktop_only",
									)}
								</h2>
								<p className="mt-2 text-muted-foreground text-sm leading-6">
									{uiMessage(
										"chat:right_pane_browser_automation_requires_electron_s_isolated_chromium_controls_link",
									)}
								</p>
							</div>
						</div>
					</div>
				)}
			</div>
		</aside>
	);
}

function PanelBody({
	executionReady,
	panel,
	active,
	folderId,
	projectId,
	environmentId,
	chatRef,
	rootPath,
	worktreeId,
	sessionId,
	planMarkdown,
	directoryUnavailable,
	cloudUnavailable,
	localTerminal,
}: {
	executionReady: boolean;
	panel: PanelInstance;
	active: boolean;
	folderId: FolderId;
	projectId: FolderId;
	environmentId: EnvironmentId;
	chatRef: ChatRef | null;
	rootPath: string;
	worktreeId: WorktreeId | null;
	sessionId: import("@zuse/contracts").SessionId | null;
	planMarkdown: string | null;
	directoryUnavailable: boolean;
	cloudUnavailable: boolean;
	localTerminal: boolean;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);

	if (cloudUnavailable && LIVE_PANEL_KINDS.has(panel.kind) && !localTerminal) {
		return (
			<div
				role="status"
				className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground"
			>
				{uiMessage(
					"chat:right_pane_this_cloud_workspace_is_disconnected_select_this_tab_to_reconnect",
				)}
			</div>
		);
	}
	if (
		directoryUnavailable &&
		(panel.kind === "files" ||
			(panel.kind === "terminal" && !localTerminal) ||
			panel.kind === "changes")
	) {
		return (
			<div
				role="status"
				className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground"
			>
				{uiMessage("chat:right_pane_this_directory_is_unavailable")}
			</div>
		);
	}
	switch (panel.kind) {
		case "files":
			return (
				<div className="min-h-0 flex-1 overflow-hidden">
					<FileTree
						key={folderId}
						folderId={folderId}
						projectId={projectId}
						environmentId={environmentId}
						rootPath={rootPath}
						worktreeId={worktreeId}
					/>
				</div>
			);
		case "terminal":
			return chatRef === null ? null : (
				<TerminalSlotPane
					chatRef={chatRef}
					rootPath={rootPath}
					slot={panel.slot}
				/>
			);
		case "changes":
			return (
				<DiffPane
					executionRef={{ environmentId, folderId, worktreeId, rootPath }}
				/>
			);
		case "pr":
			return (
				<PrPane
					executionRef={{ environmentId, folderId, worktreeId, rootPath }}
				/>
			);
		case "plan":
			return <PlanPane markdown={planMarkdown} />;
		case "device":
			if (!executionReady)
				return (
					<CompactEmptyState
						className="m-auto"
						title="Environment not connected"
						description="Connect this chat’s environment to use its simulators."
					/>
				);
			return chatRef === null ? null : (
				<SimulatorPane
					panelRef={chatRef}
					refTarget={{ ...chatRef, environmentId }}
					panelId={panel.id}
					deviceId={panel.deviceId}
					active={active}
				/>
			);
		case "browser":
			return null;
		case "subagents":
			return <SubagentsPane chatRef={chatRef} sessionId={sessionId} />;
	}
}

function PlanPane({ markdown }: { readonly markdown: string | null }) {
	if (markdown === null) return null;
	return (
		<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
			<MarkdownBody className="mx-auto max-w-3xl">{markdown}</MarkdownBody>
		</div>
	);
}

function PanelLauncher({
	actions,
	addable,
	onAdd,
	cloudTerminals,
	projectTerminalDisabledReason,
}: {
	actions: React.ReactNode;
	addable: ReadonlyArray<PanelKind>;
	onAdd: (kind: PanelKind) => void;
	cloudTerminals: CloudTerminalActions | null;
	projectTerminalDisabledReason: string | null;
}) {
	return (
		<div className="relative flex min-h-0 flex-1 flex-col items-center justify-center px-3">
			<div className="absolute right-3 top-3">{actions}</div>
			<div className="flex w-full max-w-md flex-col gap-1.5">
				{addable.flatMap((kind) => {
					const meta = PANEL_META[kind];
					return panelChoices(
						kind,
						cloudTerminals,
						onAdd,
						projectTerminalDisabledReason,
					).map((choice) => (
						<button
							key={choice.key}
							type="button"
							onClick={choice.onClick}
							disabled={choice.disabledReason !== null}
							title={choice.disabledReason ?? undefined}
							className="flex w-full items-center gap-3 rounded-lg bg-card/80 px-3 py-3 text-left text-sm text-foreground/90 transition-colors hover:bg-card/60 disabled:cursor-not-allowed disabled:opacity-50"
						>
							<HugeiconsIcon
								icon={choice.icon}
								className="size-4 shrink-0 text-muted-foreground"
							/>
							<span className="flex-1 truncate">{choice.label}</span>
							{meta.shortcut !== undefined && meta.shortcut !== "" ? (
								<kbd className="font-sans text-[11px] text-muted-foreground/70">
									{meta.shortcut}
								</kbd>
							) : null}
						</button>
					));
				})}
			</div>
		</div>
	);
}

function AddPanelMenu({
	addable,
	onAdd,
	cloudTerminals,
	projectTerminalDisabledReason,
}: {
	addable: ReadonlyArray<PanelKind>;
	onAdd: (kind: PanelKind) => void;
	cloudTerminals: CloudTerminalActions | null;
	projectTerminalDisabledReason: string | null;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);

	if (addable.length === 0) return null;
	return (
		<Menu>
			<Tooltip>
				<TooltipTrigger
					render={
						<MenuTrigger
							className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground data-[popup-open]:bg-muted/60"
							aria-label={uiMessage("chat:right_pane_add_panel")}
						>
							<Plus className="size-3.5" strokeWidth={1.8} />
						</MenuTrigger>
					}
				/>
				<TooltipPopup>{uiMessage("chat:right_pane_add_panel")}</TooltipPopup>
			</Tooltip>
			<MenuPopup align="end" className="w-72 p-1">
				{addable.length > 0
					? addable.flatMap((kind) => {
							const meta = PANEL_META[kind];
							return panelChoices(
								kind,
								cloudTerminals,
								onAdd,
								projectTerminalDisabledReason,
							).map((choice) => (
								<MenuItem
									key={choice.key}
									onClick={choice.onClick}
									disabled={choice.disabledReason !== null}
									title={choice.disabledReason ?? undefined}
									className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-sm hover:bg-sidebar-accent"
								>
									<HugeiconsIcon
										icon={choice.icon}
										className="size-3.5 opacity-80"
									/>
									<span className="min-w-0 flex-1 truncate">
										{choice.label}
									</span>
									{meta.shortcut !== undefined && meta.shortcut !== "" ? (
										<MenuShortcut>{meta.shortcut}</MenuShortcut>
									) : null}
								</MenuItem>
							));
						})
					: null}
			</MenuPopup>
		</Menu>
	);
}

function renderChangesBadge(dirtyFiles: number): React.ReactNode {
	if (dirtyFiles === 0) return null;
	return (
		<span className="flex min-w-[1rem] items-center justify-center rounded-full bg-amber-400/20 px-1 font-mono text-[10px] text-amber-200">
			{dirtyFiles}
		</span>
	);
}

function renderPrBadge(
	pr: {
		state: string;
		isDraft: boolean;
		checks: string;
		mergeable: string;
	} | null,
	details: {
		comments: ReadonlyArray<unknown>;
		reviews: ReadonlyArray<unknown>;
		checkRuns: ReadonlyArray<{ conclusion: string | null; status: string }>;
	} | null,
): React.ReactNode {
	if (pr === null || pr.state === "none") return null;
	if (pr.state === "open" && !pr.isDraft) {
		if (pr.mergeable === "conflicting") {
			return (
				<span
					className="flex items-center text-rose-300"
					title={uiMessage("chat:right_pane_merge_conflicts")}
				>
					<span className="size-2 rounded-full bg-rose-400" />
				</span>
			);
		}
		if (pr.checks === "failure") {
			const failing =
				details === null
					? null
					: details.checkRuns.filter(
							(c) =>
								c.conclusion === "failure" ||
								c.conclusion === "cancelled" ||
								c.conclusion === "timed_out" ||
								c.conclusion === "action_required",
						).length;
			return (
				<span className="flex items-center gap-1 text-rose-300">
					<span className="size-2 rounded-full border border-rose-300" />
					{failing !== null && failing > 0 ? (
						<span className="font-mono text-[10px]">{failing}</span>
					) : null}
				</span>
			);
		}
	}
	if (details === null) return null;
	const count = details.comments.length + details.reviews.length;
	if (count === 0) return null;
	return (
		<span className="flex min-w-[1rem] items-center justify-center rounded-full bg-muted px-1 font-mono text-[10px] text-foreground">
			{count}
		</span>
	);
}
