import { HugeiconsIcon } from "@hugeicons/react";
import {
	defaultModelFor,
	type EnvironmentId,
	type FolderId,
	MODELS_BY_PROVIDER,
	type ProviderId,
	type Session,
	type SessionId,
} from "@zuse/contracts";
import {
	GitCompareIcon,
	PencilEdit01Icon,
	SquareLock01Icon,
	TaskDone01Icon,
} from "@zuse/icons/solid-rounded";
import { Plus, X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import {
	type AgentActivityState,
	deriveAgentActivityState,
} from "../lib/agent-activity-state.ts";
import { resolveChatRuntimeMode } from "../lib/auto-worktree.ts";
import { deriveChatAttentionState } from "../lib/chat-attention-state.ts";
import { closeChatTab } from "../lib/close-chat-tab.ts";
import { useActiveEnvironmentEntities } from "../lib/environment-entity-hooks.ts";
import { useEnvironmentPermissions } from "../lib/environment-permissions-client-bus.ts";
import { selectAuthenticatedProvider } from "../lib/model-picker-availability.ts";
import {
	type RendererSessionTimeline,
	useRendererSessionTimelines,
} from "../lib/session-timeline-hooks.ts";
import { useSettingsStore } from "../lib/settings-client-bus.ts";
import {
	activeChatId as deriveActiveChatId,
	orderedChatTabs,
} from "../lib/tab-order.ts";
import { useChatsStore } from "../store/chats.ts";
import { useProvidersStore } from "../store/providers.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { FileIcon } from "./file-icon.tsx";
import { ProviderIcon } from "./provider-icons.tsx";
import { RenameDialog } from "./rename-dialog.tsx";
import { TypewriterText } from "./typewriter-text.tsx";
import { AgentActivityOrb } from "./ui/agent-activity-orb.tsx";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast.tsx";

type Props = {
	readonly projectId: FolderId | null;
	readonly environmentId: EnvironmentId;
	/** Fallback label when no chat is selected yet. */
	readonly emptyLabel: string;
};

const PROVIDER_LABEL: Record<ProviderId, string> = {
	claude: "Claude",
	codex: "Codex",
	grok: "Grok",
	cursor: "Cursor",
	gemini: "Gemini",
	kiro: "Kiro",
	opencode: "OpenCode",
};

const lookupModelLabel = (
	providerId: ProviderId | undefined,
	model: string | undefined,
): string | null => {
	if (providerId === undefined || model === undefined) return null;
	const opt = MODELS_BY_PROVIDER[providerId].find((m) => m.id === model);
	return opt?.label ?? model;
};

const EMPTY_SESSIONS: ReadonlyArray<Session> = [];

/**
 * Top-of-main-pane tab strip. Every tab is a session belonging to the
 * currently-active chat — uniform, no first-tab special case. The strip is
 * derived purely from server data (sessions filtered by `chatId`); there is
 * no UI-side open/closed list. Closing a tab archives the session; if it
 * was the last one in the chat, a fresh empty session is created so the
 * strip never goes empty.
 *
 * "+" creates a new session in the active chat. The server enforces that
 * the new session inherits the chat's worktree.
 */
export function MainTabs({ projectId, environmentId, emptyLabel }: Props) {
	const activeMainTab = useUiStore((s) => s.activeMainTab);
	const setActiveMainTab = useUiStore((s) => s.setActiveMainTab);
	const openFile = useUiStore((s) => s.openFile);
	const closeFileTab = useUiStore((s) => s.closeFileTab);
	const fileDirty = useUiStore((s) => s.fileDirty);
	const changesTabOpen = useUiStore((s) => s.changesTabOpen);
	const closeChangesTab = useUiStore((s) => s.closeChangesTab);

	const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);
	const { sessionsByProject } = useActiveEnvironmentEntities();
	const projectSessions =
		projectId !== null
			? (sessionsByProject[projectId] ?? EMPTY_SESSIONS)
			: EMPTY_SESSIONS;
	const selectSession = useSessionsStore((s) => s.select);
	const renameSession = useSessionsStore((s) => s.rename);
	const [renamingSession, setRenamingSession] = useState<Session | null>(null);
	// Creation progress is chat-owned and can predate a durable session status.
	// Keep it separate from provider `starting` so an empty chat stays dormant.
	const pendingCreationByChat = useChatsStore((s) => s.pendingCreationByChat);
	// Sessions with a pending permission prompt. Surfaced on the tab as a lock
	// so a supervised-mode request is visible without opening the session.
	// ExitPlanMode is excluded — plan mode owns its own inline approval card.
	const requestsById = useEnvironmentPermissions().data?.requestsById ?? {};
	const awaitingPermission = useMemo(() => {
		const ids = new Set<SessionId>();
		for (const req of Object.values(requestsById)) {
			if (req.kind._tag === "Other" && req.kind.tool === "ExitPlanMode")
				continue;
			ids.add(req.sessionId);
		}
		return ids;
	}, [requestsById]);
	const awaitingPlanApproval = useMemo(() => {
		const ids = new Set<SessionId>();
		for (const req of Object.values(requestsById)) {
			if (req.kind._tag !== "Other" || req.kind.tool !== "ExitPlanMode")
				continue;
			ids.add(req.sessionId);
		}
		return ids;
	}, [requestsById]);

	// The active chat = the chat owning the active session (if any), else
	// the sidebar's selected chat. We prefer the session-derived value
	// because it reflects the actual surface the user is looking at; the
	// chats store's `selectedChatId` may lag during transitions.
	const selectedChatId = useChatsStore((s) => s.selectedChatId);
	const activeChatId = useMemo(
		() =>
			deriveActiveChatId(projectSessions, selectedSessionId, selectedChatId),
		[selectedSessionId, projectSessions, selectedChatId],
	);

	// Tabs = all non-archived sessions in the active chat, ordered by
	// creation time so the user's mental order stays stable. Shared with the
	// keyboard navigation handlers via `lib/tab-order.ts`.
	const tabs = useMemo(
		() => orderedChatTabs(projectSessions, activeChatId),
		[projectSessions, activeChatId],
	);
	const timelineRefs = useMemo(
		() => tabs.map((session) => ({ environmentId, sessionId: session.id })),
		[environmentId, tabs],
	);
	const timelines = useRendererSessionTimelines(timelineRefs, "cache-only");
	const timelineBySession = useMemo(
		() =>
			new Map<SessionId, RendererSessionTimeline>(
				timelines.map((timeline) => [timeline.ref.sessionId, timeline]),
			),
		[timelines],
	);

	return (
		<>
			{renamingSession !== null ? (
				<RenameDialog
					title="Rename session"
					description="Change the name shown on this conversation tab."
					label="Session name"
					value={renamingSession.title}
					open
					onOpenChange={(open) => {
						if (!open) setRenamingSession(null);
					}}
					onRename={(title) => renameSession(renamingSession.id, title)}
				/>
			) : null}
			<header className="flex h-9 min-w-0 max-w-full shrink-0 items-center overflow-hidden pt-1.5">
				<div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden px-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
					{changesTabOpen ? (
						<FileTabButton
							active={activeMainTab === "changes"}
							name="Review"
							path="Review every change on this branch"
							dirty={false}
							icon={
								<HugeiconsIcon
									icon={GitCompareIcon}
									className="size-4 shrink-0"
								/>
							}
							closeLabel="Close review"
							onClick={() => setActiveMainTab("changes")}
							onClose={closeChangesTab}
						/>
					) : null}
					{openFile && (
						<FileTabButton
							active={activeMainTab === "file"}
							name={openFile.name}
							path={openFile.kind === "text" ? openFile.path : openFile.name}
							dirty={openFile.kind === "text" ? fileDirty : false}
							onClick={() => setActiveMainTab("file")}
							onClose={closeFileTab}
						/>
					)}
					{tabs.length === 0 && (
						<TabButton
							active={activeMainTab === "chat"}
							onClick={() => setActiveMainTab("chat")}
							label={emptyLabel}
						/>
					)}
					{tabs.map((session) => {
						const timeline = timelineBySession.get(session.id);
						const runtimeState = timeline?.runtime ?? "idle";
						const messages = timeline?.messages ?? [];
						const creationPending =
							pendingCreationByChat[session.chatId] !== undefined;
						const isActive =
							activeMainTab === "chat" && selectedSessionId === session.id;
						const modelLabel = lookupModelLabel(
							session.providerId,
							session.model,
						);
						const tooltip = modelLabel
							? `${session.title} — ${PROVIDER_LABEL[session.providerId]} · ${modelLabel}`
							: session.title;
						return (
							<ChatTabButton
								key={session.id}
								active={isActive}
								label={session.title}
								title={tooltip}
								providerId={session.providerId}
								booting={creationPending || runtimeState === "starting"}
								running={
									runtimeState === "running" || runtimeState === "stopping"
								}
								activityState={deriveAgentActivityState(messages)}
								awaitingPermission={awaitingPermission.has(session.id)}
								awaitingPlanApproval={
									awaitingPlanApproval.has(session.id) ||
									deriveChatAttentionState(messages, false) === "planReady"
								}
								onClick={() => {
									if (selectedSessionId !== session.id) {
										selectSession(session.id);
									}
									setActiveMainTab("chat");
								}}
								onClose={() => {
									void closeChatTab(session.id);
								}}
								onRename={() => setRenamingSession(session)}
							/>
						);
					})}
					{projectId !== null &&
						activeChatId !== null &&
						pendingCreationByChat[activeChatId] === undefined && (
							<NewChatTabButton
								chatId={activeChatId}
								environmentId={environmentId}
								projectId={projectId}
							/>
						)}
				</div>
			</header>
		</>
	);
}

function TabButton({
	active,
	onClick,
	label,
	title,
}: {
	active: boolean;
	onClick: () => void;
	label: string;
	title?: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={title ?? label}
			className={`relative flex h-6 max-w-[160px] shrink-0 items-center gap-1.5 px-2 text-[12px] transition-colors after:pointer-events-none after:absolute after:inset-x-1.5 after:-bottom-px after:h-[2px] after:rounded-full after:transition-colors ${
				active
					? "rounded-md bg-accent text-foreground after:bg-transparent"
					: "rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground after:bg-transparent"
			}`}
		>
			<span className="truncate">{label}</span>
		</button>
	);
}

export function ChatTabButton({
	active,
	label,
	title,
	providerId,
	booting,
	running,
	activityState,
	awaitingPermission,
	awaitingPlanApproval,
	onClick,
	onClose,
	onRename,
}: {
	active: boolean;
	label: string;
	title?: string;
	providerId: ProviderId;
	booting: boolean;
	running: boolean;
	activityState: AgentActivityState;
	awaitingPermission: boolean;
	awaitingPlanApproval: boolean;
	onClick: () => void;
	onClose: () => void;
	onRename: () => void;
}) {
	return (
		<div
			className={`group relative flex h-6 max-w-[160px] shrink-0 items-center gap-1 px-2 text-[12px] transition-colors after:pointer-events-none after:absolute after:inset-x-1.5 after:-bottom-px after:h-[2px] after:rounded-full after:transition-colors ${
				active
					? "rounded-md bg-accent text-foreground after:bg-transparent"
					: "rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground after:bg-transparent"
			}`}
		>
			<button
				type="button"
				onClick={onClick}
				title={title ?? label}
				className="flex h-full min-w-0 flex-1 items-center gap-1.5 py-0 leading-none"
			>
				<span className="inline-grid size-5 shrink-0 place-items-center">
					{awaitingPlanApproval ? (
						<span className="text-emerald-300" title="Plan ready to approve">
							<HugeiconsIcon icon={TaskDone01Icon} className="size-3.5" />
						</span>
					) : awaitingPermission ? (
						<span className="text-amber-300" title="Waiting for permission">
							<HugeiconsIcon icon={SquareLock01Icon} className="size-3.5" />
						</span>
					) : booting || running ? (
						<AgentActivityOrb
							state={booting ? "working" : activityState}
							label={booting ? "Starting agent" : `Agent is ${activityState}`}
						/>
					) : (
						<ProviderIcon
							providerId={providerId}
							className="size-3.5 text-foreground"
						/>
					)}
				</span>
				<span className="min-w-0 truncate leading-none">
					<TypewriterText text={label} className="truncate" />
				</span>
			</button>
			<div className="absolute right-0.5 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-accent p-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
				<button
					type="button"
					onClick={(event) => {
						event.stopPropagation();
						onRename();
					}}
					aria-label={`Rename ${label}`}
					title="Rename session"
					className="rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
				>
					<HugeiconsIcon icon={PencilEdit01Icon} className="size-3" />
				</button>
				<button
					type="button"
					onClick={(event) => {
						event.stopPropagation();
						onClose();
					}}
					aria-label="Close chat"
					className="rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
				>
					<X className="size-3" strokeWidth={1.8} />
				</button>
			</div>
		</div>
	);
}

function NewChatTabButton({
	chatId,
	environmentId,
	projectId,
}: {
	chatId: import("@zuse/contracts").ChatId;
	environmentId: EnvironmentId;
	projectId: FolderId | null;
}) {
	const loadAvailability = useProvidersStore((s) => s.loadFor);
	const create = useSessionsStore((s) => s.create);
	const creating = useSessionsStore((s) => s.creatingByChat[chatId] === true);
	const [preparing, setPreparing] = useState(false);
	const busy = creating || preparing;
	const defaultProviderId = useSettingsStore((s) => s.defaultProviderId);
	const defaultModelByProvider = useSettingsStore(
		(s) => s.defaultModelByProvider,
	);
	const providerEnabled = useSettingsStore((s) => s.providerEnabled);

	// Creates a new session inside the active chat. Worktree is inherited
	// from the chat row server-side. Availability is cached per environment,
	// so only the first click probes the runtime; importantly, a local default
	// can never select a provider that is signed out in this cloud workspace.
	const onClick = async () => {
		if (busy) return;
		setPreparing(true);
		try {
			await loadAvailability(environmentId);
			const environmentAvailability =
				useProvidersStore.getState().availabilityByEnvironment[environmentId]
					?.availability ?? [];
			const providerId = selectAuthenticatedProvider({
				preferredProviderId: defaultProviderId,
				providerIds: Object.keys(
					MODELS_BY_PROVIDER,
				) as ReadonlyArray<ProviderId>,
				availability: environmentAvailability,
				providerEnabled,
			});
			if (providerId === null) {
				toastManager.add({
					type: "error",
					title: "No authenticated agent",
					description:
						"Connect an agent in Cloud Authentication before opening a new tab.",
				});
				return;
			}
			const model =
				defaultModelByProvider[providerId] ?? defaultModelFor(providerId);
			const runtimeMode =
				projectId === null
					? useSettingsStore.getState().defaultRuntimeMode
					: await resolveChatRuntimeMode(environmentId, projectId);
			await create(chatId, providerId, model, {
				runtimeMode,
			});
		} finally {
			setPreparing(false);
		}
	};

	return (
		<button
			type="button"
			onClick={() => void onClick()}
			disabled={busy}
			title="New tab in this chat"
			aria-label="New tab in this chat"
			className="relative flex shrink-0 items-center justify-center rounded px-2 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
		>
			{busy ? (
				<span className="inline-flex size-3.5 items-center justify-center">
					<Spinner className="size-3.5" />
				</span>
			) : (
				<Plus className="size-3.5" strokeWidth={1.8} />
			)}
		</button>
	);
}

function FileTabButton({
	active,
	name,
	path,
	dirty,
	icon,
	closeLabel = "Close file",
	onClick,
	onClose,
}: {
	active: boolean;
	name: string;
	path: string;
	dirty: boolean;
	icon?: ReactNode;
	closeLabel?: string;
	onClick: () => void;
	onClose: () => void;
}) {
	return (
		<div
			className={`group relative flex h-6 max-w-[160px] shrink-0 items-center gap-1 px-2 text-[12px] leading-none transition-colors after:pointer-events-none after:absolute after:inset-x-1.5 after:-bottom-px after:h-[2px] after:rounded-full after:transition-colors ${
				active
					? "rounded-md bg-accent text-foreground after:bg-transparent"
					: "rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground after:bg-transparent"
			}`}
		>
			<button
				type="button"
				onClick={onClick}
				title={dirty ? `${path} (unsaved)` : path}
				className="flex h-full min-w-0 flex-1 items-center gap-1.5 py-0 leading-none"
			>
				{icon ?? (
					<FileIcon name={name} kind="file" className="size-4 shrink-0" />
				)}
				<span className="truncate leading-none">{name}</span>
				{dirty ? (
					<span
						aria-hidden="true"
						className="size-1.5 shrink-0 rounded-full bg-yellow-300"
					/>
				) : null}
			</button>
			<button
				type="button"
				onClick={onClose}
				aria-label={closeLabel}
				className="absolute right-0.5 top-1/2 z-10 -translate-y-1/2 rounded-md bg-accent p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
			>
				<X className="size-3" strokeWidth={1.8} />
			</button>
		</div>
	);
}
