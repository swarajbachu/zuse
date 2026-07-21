import { HugeiconsIcon } from "@hugeicons/react";
import {
	GitCompareIcon,
	SquareLock01Icon,
	TaskDone01Icon,
} from "@hugeicons-pro/core-stroke-rounded";
import {
	defaultModelFor,
	type FolderId,
	MODELS_BY_PROVIDER,
	type ProviderId,
	type Session,
	type SessionId,
} from "@zuse/contracts";
import { Plus, X } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { deriveChatAttentionState } from "../lib/chat-attention-state.ts";
import {
	activeChatId as deriveActiveChatId,
	orderedChatTabs,
} from "../lib/tab-order.ts";
import { useChatsStore } from "../store/chats.ts";
import { useMessagesStore } from "../store/messages.ts";
import { usePermissionsStore } from "../store/permissions.ts";
import { useProvidersStore } from "../store/providers.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useSettingsStore } from "../store/settings.ts";
import { useUiStore } from "../store/ui.ts";
import { FileIcon } from "./file-icon.tsx";
import { ProviderIcon } from "./provider-icons.tsx";
import { Spinner } from "./ui/spinner";

type Props = {
	readonly projectId: FolderId | null;
	/** Fallback label when no chat is selected yet. */
	readonly emptyLabel: string;
};

const PROVIDER_LABEL: Record<ProviderId, string> = {
	claude: "Claude",
	codex: "Codex",
	grok: "Grok",
	cursor: "Cursor",
	gemini: "Gemini",
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
export function MainTabs({ projectId, emptyLabel }: Props) {
	const activeMainTab = useUiStore((s) => s.activeMainTab);
	const setActiveMainTab = useUiStore((s) => s.setActiveMainTab);
	const openFile = useUiStore((s) => s.openFile);
	const closeFileTab = useUiStore((s) => s.closeFileTab);
	const fileDirty = useUiStore((s) => s.fileDirty);
	const changesTabOpen = useUiStore((s) => s.changesTabOpen);
	const closeChangesTab = useUiStore((s) => s.closeChangesTab);

	const selectedSessionId = useSessionsStore((s) => s.selectedSessionId);
	const projectSessions = useSessionsStore((s) =>
		projectId !== null
			? (s.sessionsByProject[projectId] ?? EMPTY_SESSIONS)
			: EMPTY_SESSIONS,
	);
	const selectSession = useSessionsStore((s) => s.select);
	// Per-session running flag — drives the provider-icon → Spinner swap on
	// each tab so the user sees which session is streaming at a glance.
	const runningBySession = useMessagesStore((s) => s.runningBySession);
	const sidebarMessagesBySession = useMessagesStore((s) => s.messagesBySession);
	// Sessions with a pending permission prompt. Surfaced on the tab as a lock
	// so a supervised-mode request is visible without opening the session.
	// ExitPlanMode is excluded — plan mode owns its own inline approval card.
	const requestsById = usePermissionsStore((s) => s.requestsById);
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

	return (
		<header className="flex h-10 shrink-0 items-stretch border-b border-border">
			<div className="flex items-stretch gap-1 px-2">
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
							running={runningBySession[session.id] === true}
							awaitingPermission={awaitingPermission.has(session.id)}
							awaitingPlanApproval={
								awaitingPlanApproval.has(session.id) ||
								deriveChatAttentionState(
									sidebarMessagesBySession[session.id] ?? [],
									false,
								) === "planReady"
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
						/>
					);
				})}
				{projectId !== null && activeChatId !== null && (
					<NewChatTabButton chatId={activeChatId} />
				)}
			</div>
			<div className="flex-1" />
		</header>
	);
}

/**
 * Close the active chat tab. Shared between the X click and the Cmd+W menu
 * accelerator (subscribed in `app.tsx`). Logic lives outside the component
 * so the keyboard handler doesn't depend on which tab the user is hovering.
 */
export const closeActiveChatTab = async (): Promise<void> => {
	const sessions = useSessionsStore.getState();
	const sessionId = sessions.selectedSessionId;
	if (sessionId === null) return;
	await closeChatTab(sessionId);
};

const closeChatTab = async (sessionId: SessionId): Promise<void> => {
	const sessions = useSessionsStore.getState();
	// Locate the session row + its project group.
	let projectId: FolderId | null = null;
	let session: Session | null = null;
	for (const [pid, list] of Object.entries(sessions.sessionsByProject)) {
		const match = list.find((row) => row.id === sessionId);
		if (match !== undefined) {
			projectId = pid as FolderId;
			session = match;
			break;
		}
	}
	if (projectId === null || session === null) return;

	const projectRows = sessions.sessionsByProject[projectId] ?? EMPTY_SESSIONS;
	// Live siblings in the same chat (excluding the one we're closing) sorted
	// by creation time — used to pick the next active tab and to detect the
	// "last tab" case.
	const siblings = projectRows
		.filter(
			(row) =>
				row.chatId === session!.chatId &&
				row.archivedAt === null &&
				row.id !== session!.id,
		)
		.slice()
		.sort(
			(a, b) =>
				new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
		);

	if (siblings.length > 0) {
		// Not the last tab — archive and refocus the right neighbor (else left).
		const idx = projectRows
			.filter(
				(row) => row.chatId === session!.chatId && row.archivedAt === null,
			)
			.sort(
				(a, b) =>
					new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
			)
			.findIndex((row) => row.id === session!.id);
		const ordered = projectRows
			.filter(
				(row) =>
					row.chatId === session!.chatId &&
					row.archivedAt === null &&
					row.id !== session!.id,
			)
			.sort(
				(a, b) =>
					new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
			);
		const next = ordered[idx] ?? ordered[idx - 1] ?? ordered[0] ?? null;
		await sessions.archive(sessionId);
		sessions.select(next?.id ?? null);
		return;
	}

	// Last tab in the chat — archive AND spawn a fresh empty session in the
	// same chat so the strip never goes empty. Provider/model defaults come
	// from the user's settings.
	const settings = useSettingsStore.getState();
	const providersRefresh = useProvidersStore.getState().refresh;
	await providersRefresh();
	const providerId = settings.defaultProviderId;
	const model =
		settings.defaultModelByProvider[providerId] ?? defaultModelFor(providerId);
	await sessions.archive(session.id);
	await sessions.create(session.chatId, providerId, model, {
		runtimeMode: settings.defaultRuntimeMode,
	});
};

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
			className={`relative flex max-w-[280px] items-center gap-2 px-3 text-[12px] transition-colors after:pointer-events-none after:absolute after:inset-x-2 after:-bottom-px after:h-[2px] after:rounded-full after:transition-colors ${
				active
					? "text-foreground after:bg-foreground"
					: "text-muted-foreground hover:text-foreground after:bg-transparent"
			}`}
		>
			<span className="truncate">{label}</span>
		</button>
	);
}

function ChatTabButton({
	active,
	label,
	title,
	providerId,
	running,
	awaitingPermission,
	awaitingPlanApproval,
	onClick,
	onClose,
}: {
	active: boolean;
	label: string;
	title?: string;
	providerId: ProviderId;
	running: boolean;
	awaitingPermission: boolean;
	awaitingPlanApproval: boolean;
	onClick: () => void;
	onClose: () => void;
}) {
	return (
		<div
			className={`group relative flex max-w-[280px] items-center gap-1.5 px-3 text-[12px] transition-colors after:pointer-events-none after:absolute after:inset-x-2 after:-bottom-px after:h-[2px] after:rounded-full after:transition-colors ${
				active
					? "text-foreground after:bg-foreground"
					: "text-muted-foreground hover:text-foreground after:bg-transparent"
			}`}
		>
			<button
				type="button"
				onClick={onClick}
				title={title ?? label}
				className="flex h-full min-w-0 flex-1 items-center gap-1.5 py-0 leading-none"
			>
				{awaitingPlanApproval ? (
					<span
						className="inline-flex size-3.5 shrink-0 items-center justify-center text-emerald-300"
						title="Plan ready to approve"
					>
						<HugeiconsIcon icon={TaskDone01Icon} className="size-3.5" />
					</span>
				) : awaitingPermission ? (
					<span
						className="inline-flex size-3.5 shrink-0 items-center justify-center text-amber-300"
						title="Waiting for permission"
					>
						<HugeiconsIcon icon={SquareLock01Icon} className="size-3.5" />
					</span>
				) : running ? (
					<span className="inline-flex size-3.5 shrink-0 items-center justify-center text-foreground">
						<Spinner className="size-3.5" />
					</span>
				) : (
					<ProviderIcon
						providerId={providerId}
						className="size-3.5 shrink-0 text-foreground"
					/>
				)}
				<span className="truncate leading-none">{label}</span>
			</button>
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					onClose();
				}}
				aria-label="Close chat"
				className="relative z-10 rounded p-0.5 opacity-0 transition-opacity hover:bg-foreground/10 group-hover:opacity-100"
			>
				<X className="size-3" strokeWidth={1.8} />
			</button>
		</div>
	);
}

function NewChatTabButton({
	chatId,
}: {
	chatId: import("@zuse/contracts").ChatId;
}) {
	const refresh = useProvidersStore((s) => s.refresh);
	const create = useSessionsStore((s) => s.create);
	const creating = useSessionsStore((s) => s.creatingByChat[chatId] === true);
	const defaultProviderId = useSettingsStore((s) => s.defaultProviderId);
	const defaultModelByProvider = useSettingsStore(
		(s) => s.defaultModelByProvider,
	);
	const defaultRuntimeMode = useSettingsStore((s) => s.defaultRuntimeMode);

	// Creates a new session inside the active chat. Worktree is inherited
	// from the chat row server-side. Skip the awaited provider refresh when
	// we already have a default model cached — saves 100–500ms per click on
	// the warm path; cold cache still pays for the round-trip.
	const onClick = async () => {
		if (creating) return;
		if (defaultModelByProvider[defaultProviderId] === undefined) {
			await refresh();
		}
		const model =
			defaultModelByProvider[defaultProviderId] ??
			defaultModelFor(defaultProviderId);
		void create(chatId, defaultProviderId, model, {
			runtimeMode: defaultRuntimeMode,
		});
	};

	return (
		<button
			type="button"
			onClick={() => void onClick()}
			disabled={creating}
			title="New tab in this chat"
			aria-label="New tab in this chat"
			className="relative flex items-center justify-center rounded px-2 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
		>
			{creating ? (
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
			className={`group relative flex max-w-[280px] items-center gap-1.5 px-3 text-[12px] leading-none transition-colors after:pointer-events-none after:absolute after:inset-x-2 after:-bottom-px after:h-[2px] after:rounded-full after:transition-colors ${
				active
					? "text-foreground after:bg-foreground"
					: "text-muted-foreground hover:text-foreground after:bg-transparent"
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
				className="relative z-10 rounded p-0.5 opacity-0 transition-opacity hover:bg-foreground/10 group-hover:opacity-100"
			>
				<X className="size-3" strokeWidth={1.8} />
			</button>
		</div>
	);
}
