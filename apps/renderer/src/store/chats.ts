import {
	Chat,
	type ChatArchiveJob,
	type ChatArchiveResult,
	type ChatCreationOperation,
	ChatId,
	type ChatUnarchiveResult,
	type ChatWorkspacePolicy,
	CommandId,
	ComposerInput,
	EnvironmentId,
	type FolderId,
	type PermissionMode,
	type ProviderId,
	type RuntimeMode,
	Session,
	SessionId,
	type WorktreeId,
} from "@zuse/contracts";
import { composerInputStartsDirectTurn } from "@zuse/domain/conversation/startup-input";
import { toastManager } from "../components/ui/toast.tsx";
import { nextChatCreateCommandId } from "../lib/chat-create-command-id.ts";
import {
	cloudSummaryForChat,
	optimisticallyUnarchiveCloudChat,
} from "../lib/cloud-workspace-catalog.ts";
import {
	activeChatsByProject,
	activeSessionsByProject,
	overlayActiveEnvironmentShell,
} from "../lib/environment-entities.ts";
import {
	dispatchEnvironmentShellCommand,
	environmentShellResourceKey,
} from "../lib/environment-shell-client-bus.ts";
import { formatError } from "../lib/format-error.ts";
import { upsertLatestEntity } from "../lib/latest-entity.ts";
import { markRendererInteraction } from "../lib/performance-marks.ts";
import {
	getActiveEnvironment,
	isIgnorableRendererFailure,
} from "../lib/rpc-client.ts";
import {
	dropQueuedMessage,
	queueSessionMessage,
} from "../lib/session-actions.ts";
import {
	sessionTimelineCache,
	timelineReadingPositionStore,
} from "../lib/session-timeline-cache.ts";
import {
	dispatchSessionCommand,
	getRendererClientBus,
	restartSessionTimeline,
} from "../lib/session-timeline-client-bus.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { batchAtomUpdates } from "../state/registry.tsx";
import { useArchivePreviewStore } from "./archive-preview.ts";
import { registerChatCommands } from "./chat-commands.ts";
import { useSessionsStore } from "./sessions.ts";
import { useTerminalsStore } from "./terminals.ts";
import { useUiStore } from "./ui.ts";
import { useWorkspaceStore } from "./workspace.ts";
import { useWorktreesStore } from "./worktrees.ts";

export type ChatArchiveProgressPhase = "archiving";

export type ChatUnarchiveOutcome =
	| ({ readonly ok: true } & ChatUnarchiveResult)
	| { readonly ok: false; readonly reason: string };

const unarchivePromises = new Map<ChatId, Promise<ChatUnarchiveOutcome>>();
const archiveStatusTimers = new Map<ChatId, number>();
const notifiedArchiveFailures = new Set<ChatId>();

const activeChatRef = (chatId: ChatId) => ({
	environmentId: EnvironmentId.make(getActiveEnvironment()),
	chatId,
});

let chatCommandCounter = 0;
const nextChatCommandId = (kind: string): CommandId =>
	CommandId.make(
		`${kind}:${Date.now().toString(36)}:${(chatCommandCounter++).toString(36)}`,
	);

const dispatchChatCommand = <Payload, Result>(input: {
	readonly environmentId?: string;
	readonly kind: string;
	readonly commandId?: CommandId;
	readonly payload: Payload;
	readonly retry?: "safe" | "never";
}) =>
	dispatchEnvironmentShellCommand<Payload, Result>({
		environmentId: EnvironmentId.make(
			input.environmentId ?? getActiveEnvironment(),
		),
		kind: input.kind,
		commandId: input.commandId ?? nextChatCommandId(input.kind),
		payload: input.payload,
		retry: input.retry,
	});

export const resolveChatSessionSelection = (
	activeSessionId: SessionId | null,
	liveSessions: ReadonlyArray<Pick<Session, "id">>,
): {
	readonly sessionId: SessionId | null;
	readonly recoverArchivedSessionId: SessionId | null;
} => {
	const active =
		activeSessionId === null
			? undefined
			: liveSessions.find((session) => session.id === activeSessionId);
	const sessionId = active?.id ?? liveSessions[0]?.id ?? null;
	return {
		sessionId,
		recoverArchivedSessionId: sessionId === null ? activeSessionId : null,
	};
};

export const chatRecoveryIsCurrentSelection = ({
	chatId,
	projectId,
	selectedChatId,
	selectedProjectId,
}: {
	readonly chatId: ChatId;
	readonly projectId: FolderId;
	readonly selectedChatId: ChatId | null;
	readonly selectedProjectId: FolderId | null;
}): boolean => chatId === selectedChatId && projectId === selectedProjectId;

const recoverArchivedActiveSession = async (
	chatId: ChatId,
	projectId: FolderId,
	sessionId: SessionId,
): Promise<void> => {
	try {
		const ref = {
			environmentId: EnvironmentId.make(getActiveEnvironment()),
			sessionId,
		};
		await dispatchSessionCommand<{ readonly sessionId: SessionId }, void>({
			ref,
			kind: "session.unarchive",
			commandId: nextChatCommandId("session-unarchive"),
			payload: { sessionId },
		});
		if (
			!chatRecoveryIsCurrentSelection({
				chatId,
				projectId,
				selectedChatId: useChatsStore.getState().selectedChatId,
				selectedProjectId: useWorkspaceStore.getState().selectedFolderId,
			})
		) {
			return;
		}
		const { result: session } = await dispatchSessionCommand<
			{ readonly sessionId: SessionId },
			Session
		>({
			ref,
			kind: "session.get",
			commandId: nextChatCommandId("session-get"),
			payload: { sessionId },
			retry: "never",
		});
		if (session.chatId !== chatId || session.projectId !== projectId) {
			throw new Error("The restored session does not belong to this chat.");
		}
		overlayActiveEnvironmentShell((shell) => ({
			...shell,
			sessionsByProject: {
				...shell.sessionsByProject,
				[projectId]: upsertLatestEntity(
					shell.sessionsByProject[projectId] ?? [],
					session,
				),
			},
		}));
		if (
			chatRecoveryIsCurrentSelection({
				chatId,
				projectId,
				selectedChatId: useChatsStore.getState().selectedChatId,
				selectedProjectId: useWorkspaceStore.getState().selectedFolderId,
			})
		) {
			useSessionsStore.setState((state) => ({
				selectedSessionId: sessionId,
				selectedSessionByProject: {
					...state.selectedSessionByProject,
					[projectId]: sessionId,
				},
			}));
		}
	} catch (error) {
		if (
			chatRecoveryIsCurrentSelection({
				chatId,
				projectId,
				selectedChatId: useChatsStore.getState().selectedChatId,
				selectedProjectId: useWorkspaceStore.getState().selectedFolderId,
			})
		) {
			useChatsStore.setState({ error: formatError(error) });
		}
	}
};

export const chatStartupUsesQueue = (
	input: ComposerInput | undefined,
	ready: boolean,
): boolean =>
	input !== undefined && (!ready || !composerInputStartsDirectTurn(input));

type ChatCreateResult = Readonly<{
	chat: Chat;
	initialSession: Session;
	initialMessage: import("@zuse/contracts").Message | null;
}>;

const notifyArchiveFailure = (job: ChatArchiveJob): void => {
	if (notifiedArchiveFailures.has(job.chatId)) return;
	notifiedArchiveFailures.add(job.chatId);
	toastManager.add({
		type: "error",
		title: "Archive cleanup failed",
		description:
			job.error ?? "The chat is archived, but its directory was preserved.",
		actionProps: {
			children: "Force archive",
			onClick: () => void useChatsStore.getState().archive(job.chatId, true),
		},
	});
};

const monitorArchiveJob = (chatId: ChatId): void => {
	if (archiveStatusTimers.has(chatId)) return;
	const poll = async () => {
		try {
			const { result: job } = await dispatchChatCommand<
				{ readonly chatId: ChatId },
				ChatArchiveJob | null
			>({ kind: "chat.archiveStatus", payload: { chatId } });
			if (
				job === null ||
				["completed", "forced", "cancelled"].includes(job.status)
			) {
				archiveStatusTimers.delete(chatId);
				return;
			}
			if (job.status === "failed") {
				archiveStatusTimers.delete(chatId);
				notifyArchiveFailure(job);
				return;
			}
		} catch {
			// Retry after reconnect; transport failures are not archive failures.
		}
		archiveStatusTimers.set(chatId, window.setTimeout(poll, 2_000));
	};
	archiveStatusTimers.set(chatId, window.setTimeout(poll, 2_000));
};

export const chatArchiveProgressLabel = (
	_phase: ChatArchiveProgressPhase,
): string => "Archiving chat…";

/**
 * Ephemeral chat selection/creation UI state and commands. Canonical chat
 * entities are owned by the qualified environment-shell ClientBus resource.
 *
 * `activeSessionId` (mirrored from the server's `chats.active_session_id`
 * column) is the last tab the user was on inside a chat. Clicking a chat in
 * the sidebar restores that tab — no in-memory memo required.
 */
type ChatsState = {
	/** Mirror of `selectedChatByProject[selectedFolderId]`. */
	readonly selectedChatId: ChatId | null;
	readonly selectedChatByProject: Record<string, ChatId | null>;
	readonly loadingByProject: Record<string, boolean>;
	/** Per-project in-flight flag for `create()`. Drives the sidebar
	 * "New chat" button's icon swap (SquarePen → Spinner). */
	readonly creatingByProject: Record<string, boolean>;
	/**
	 * Optimistic creation shells keyed by their stable chat id. These exist
	 * before `chat.create` acknowledges, allowing every surface to render the
	 * same truthful lifecycle without issuing session-scoped RPCs prematurely.
	 */
	readonly pendingCreationByChat: Record<string, PendingChatCreation>;
	/** Archive tombstones prevent stale summary frames from reviving hidden rows. */
	readonly hiddenArchivedChatIds: ReadonlySet<ChatId>;
	readonly retryCreation: (
		chatId: ChatId,
		preserveFocus?: boolean,
	) => Promise<boolean>;
	readonly continueCreation: (chatId: ChatId) => Promise<boolean>;
	/** Provider output proves the startup lifecycle crossed into a live turn. */
	readonly completeCreation: (chatId: ChatId) => void;
	readonly discardCreation: (chatId: ChatId) => void;
	readonly archiveProgressByChat: Record<string, ChatArchiveProgressPhase>;
	readonly error: string | null;
	readonly hydrate: (projectId: FolderId) => Promise<void>;
	readonly create: (
		projectId: FolderId,
		providerId: ProviderId,
		model: string,
		opts?: {
			readonly title?: string;
			/**
			 * Create the chat on another computer. When set to a non-active
			 * environment the RPC is addressed to that environment's own client,
			 * every local-store write is skipped (the target's stores are seeded
			 * during the follow-up switch), and only the prompt TEXT of
			 * `startupInput` is delivered via the server-side `initialPrompt`.
			 */
			readonly environmentId?: string;
			readonly runtimeMode?: RuntimeMode;
			readonly worktreeId?: WorktreeId | null | Promise<WorktreeId | null>;
			readonly workspacePolicy?:
				| ChatWorkspacePolicy
				| Promise<ChatWorkspacePolicy>;
			readonly permissionMode?: PermissionMode;
			readonly toolSearch?: boolean;
			readonly startupInput?: ComposerInput;
			/** False while the renderer must still materialize context/attachments. */
			readonly startupReady?: boolean;
			readonly workspaceRequested?: boolean;
			/** Stable retry fields used only by the creation lifecycle. */
			readonly operationId?: string;
			readonly chatId?: ChatId;
			readonly initialSessionId?: SessionId;
			readonly startupQueueId?: string;
			readonly reusePending?: boolean;
			readonly preserveFocus?: boolean;
		},
	) => Promise<{
		readonly chatId: ChatId;
		readonly initialSessionId: SessionId;
		readonly worktreeId: WorktreeId | null;
		readonly startupQueueId: string | null;
		/** Present only for remote-targeted creates: entities to seed during the switch. */
		readonly remoteSeed?: {
			readonly chat: Chat;
			readonly initialSession: Session;
		};
	} | null>;
	readonly rename: (chatId: ChatId, title: string) => Promise<void>;
	readonly setWorktree: (
		chatId: ChatId,
		worktreeId: WorktreeId | null,
	) => Promise<{ readonly ok: true } | { readonly ok: false; reason: string }>;
	readonly setActiveSession: (
		chatId: ChatId,
		sessionId: SessionId,
	) => Promise<void>;
	readonly archive: (
		chatId: ChatId,
		force?: boolean,
	) => Promise<
		{ readonly ok: true } | { readonly ok: false; readonly reason: string }
	>;
	readonly setArchiveProgress: (
		chatId: ChatId,
		phase: ChatArchiveProgressPhase,
	) => void;
	readonly clearArchiveProgress: (chatId: ChatId) => void;
	readonly unarchive: (chatId: ChatId) => Promise<ChatUnarchiveOutcome>;
	readonly remove: (chatId: ChatId) => Promise<void>;
	readonly select: (chatId: ChatId | null) => void;
	/**
	 * Stamp the chat read (clears its unread style). Optimistic — patches the
	 * cached `lastReadAt` immediately, then persists via `chat.markRead`.
	 */
	readonly markRead: (chatId: ChatId) => Promise<void>;
	/**
	 * Optimistically advance a chat's cached `lastMessageAt` to "now". Driven
	 * by the live per-session status signal so a background chat lights up
	 * unread the instant its agent finishes a turn, without a chat re-hydrate.
	 */
	readonly noteChatActivity: (chatId: ChatId) => void;
};

export type PendingChatCreation = {
	readonly operationId: string;
	readonly chatId: ChatId;
	readonly sessionId: SessionId;
	readonly projectId: FolderId;
	readonly providerId: ProviderId;
	readonly model: string;
	readonly title: string | undefined;
	readonly runtimeMode: RuntimeMode | undefined;
	readonly permissionMode: PermissionMode | undefined;
	readonly toolSearch: boolean | undefined;
	readonly startupInput: ComposerInput | undefined;
	readonly startupReady: boolean;
	readonly prompt: string | null;
	readonly workspaceRequested: boolean;
	readonly worktreeId: WorktreeId | null;
	readonly workspacePolicy: ChatWorkspacePolicy | null;
	readonly phase: ChatCreationOperation["phase"];
	readonly failureStage: ChatCreationOperation["failureStage"];
	readonly retryable: boolean;
	readonly attempts: ChatCreationOperation["attempts"];
	readonly setupBypassed: boolean;
	readonly error: string | null;
	readonly previousChatId: ChatId | null;
	readonly previousSessionId: SessionId | null;
	readonly startupQueueId: string | null;
	readonly createdAt: Date;
	readonly startedAt: number;
};

export const pendingCreationEntities = (
	creation: PendingChatCreation,
): { readonly chat: Chat; readonly session: Session } => {
	const title = creation.title?.trim() || "New chat";
	return {
		chat: Chat.make({
			id: creation.chatId,
			projectId: creation.projectId,
			worktreeId: creation.worktreeId,
			title,
			titleProvenance: creation.title === undefined ? "pending" : "manual",
			activeSessionId: creation.sessionId,
			originSessionId: null,
			archivedAt: null,
			lastMessageAt: null,
			lastReadAt: creation.createdAt,
			createdAt: creation.createdAt,
			updatedAt: creation.createdAt,
		}),
		session: Session.make({
			id: creation.sessionId,
			projectId: creation.projectId,
			title,
			titleProvenance: creation.title === undefined ? "pending" : "manual",
			providerId: creation.providerId,
			model: creation.model,
			status: creation.phase === "failed" ? "error" : "booting",
			archivedAt: null,
			cursor: null,
			resumeStrategy: "none",
			runtimeMode: creation.runtimeMode ?? "approval-required",
			worktreeId: creation.worktreeId,
			chatId: creation.chatId,
			forkedFromSessionId: null,
			forkedFromMessageId: null,
			permissionMode: creation.permissionMode ?? "default",
			toolSearch: creation.toolSearch ?? false,
			createdAt: creation.createdAt,
			updatedAt: creation.createdAt,
		}),
	};
};

export const chatStoreErrorMessage = (cause: unknown): string | null =>
	isIgnorableRendererFailure(cause) ? null : formatError(cause);

/**
 * A chat is unread when it has message activity the user hasn't seen since
 * last viewing it. The currently-selected chat is always treated as read.
 */
export const isChatUnread = (
	chat: Chat,
	selectedChatId: ChatId | null,
): boolean => {
	if (chat.id === selectedChatId) return false;
	if (chat.archivedAt !== null) return false;
	if (chat.lastMessageAt === null) return false;
	if (chat.lastReadAt === null) return true;
	return chat.lastMessageAt.getTime() > chat.lastReadAt.getTime();
};

const creationRetryPromises = new Map<string, Promise<boolean>>();

const findChatProject = (
	chatsByProject: Readonly<Record<string, ReadonlyArray<Chat>>>,
	chatId: ChatId,
): FolderId | null => {
	for (const [pid, chats] of Object.entries(chatsByProject)) {
		if (chats.some((c) => c.id === chatId)) return pid as FolderId;
	}
	return null;
};

const chatSortTime = (chat: Chat): number =>
	(chat.updatedAt ?? chat.createdAt).getTime();

const upsertChat = (
	chats: ReadonlyArray<Chat>,
	chat: Chat,
): ReadonlyArray<Chat> =>
	[...upsertLatestEntity(chats, chat)].sort(
		(a, b) => chatSortTime(b) - chatSortTime(a),
	);

export const restorePendingCreation = (
	operation: ChatCreationOperation,
): {
	readonly chat: Chat;
	readonly session: Session;
	readonly creation: PendingChatCreation;
} => {
	const now = operation.updatedAt;
	const title = operation.title?.trim() || "New chat";
	const startupInput =
		operation.startupInput ??
		(operation.prompt === null
			? undefined
			: ComposerInput.make({
					text: operation.prompt,
					attachments: [],
					fileRefs: [],
					skillRefs: [],
				}));
	return {
		chat: Chat.make({
			id: operation.chatId,
			projectId: operation.projectId,
			worktreeId: operation.worktreeId,
			title,
			titleProvenance: operation.title === null ? "pending" : "manual",
			activeSessionId: operation.initialSessionId,
			originSessionId: null,
			archivedAt: null,
			lastMessageAt: null,
			lastReadAt: now,
			createdAt: operation.createdAt,
			updatedAt: now,
		}),
		session: Session.make({
			id: operation.initialSessionId,
			projectId: operation.projectId,
			title,
			titleProvenance: operation.title === null ? "pending" : "manual",
			providerId: operation.providerId,
			model: operation.model,
			status: operation.phase === "failed" ? "error" : "booting",
			archivedAt: null,
			cursor: null,
			resumeStrategy: "none",
			runtimeMode: operation.runtimeMode,
			worktreeId: operation.worktreeId,
			chatId: operation.chatId,
			forkedFromSessionId: null,
			forkedFromMessageId: null,
			permissionMode: operation.permissionMode,
			toolSearch: operation.toolSearch,
			createdAt: operation.createdAt,
			updatedAt: now,
		}),
		creation: {
			operationId: operation.operationId,
			chatId: operation.chatId,
			sessionId: operation.initialSessionId,
			projectId: operation.projectId,
			providerId: operation.providerId,
			model: operation.model,
			title: operation.title ?? undefined,
			runtimeMode: operation.runtimeMode,
			permissionMode: operation.permissionMode,
			toolSearch: operation.toolSearch,
			startupInput,
			startupReady: operation.startupReady,
			prompt: operation.prompt,
			workspaceRequested: operation.workspacePolicy._tag !== "main",
			worktreeId: operation.worktreeId,
			workspacePolicy: operation.workspacePolicy,
			phase: operation.phase,
			failureStage: operation.failureStage,
			retryable: operation.retryable,
			attempts: operation.attempts,
			setupBypassed: operation.setupBypassed,
			error: operation.error,
			previousChatId: null,
			previousSessionId: null,
			startupQueueId: operation.startupQueueId,
			createdAt: operation.createdAt,
			startedAt: performance.now(),
		},
	};
};

export const useChatsStore = create<ChatsState>((set, get) => ({
	selectedChatId: null,
	selectedChatByProject: {},
	loadingByProject: {},
	creatingByProject: {},
	pendingCreationByChat: {},
	hiddenArchivedChatIds: new Set(),
	archiveProgressByChat: {},
	error: null,
	hydrate: async (projectId) => {
		set((s) => ({
			loadingByProject: { ...s.loadingByProject, [projectId]: true },
			error: null,
		}));
		try {
			const [archiveReceipt, creationReceipt] = await Promise.all([
				dispatchChatCommand<
					{ readonly projectId: FolderId },
					ReadonlyArray<ChatArchiveJob>
				>({ kind: "chat.archiveJobs", payload: { projectId } }),
				dispatchChatCommand<
					{ readonly projectId: FolderId },
					ReadonlyArray<ChatCreationOperation>
				>({ kind: "chat.creation.list", payload: { projectId } }),
			]);
			const archiveJobs = archiveReceipt.result;
			const creationOperations = creationReceipt.result;
			for (const job of archiveJobs) {
				if (job.status === "failed") notifyArchiveFailure(job);
				else monitorArchiveJob(job.chatId);
			}
			const restored = creationOperations
				.filter(
					(operation) =>
						operation.phase !== "running" && operation.phase !== "cancelled",
				)
				.map(restorePendingCreation);
			const succeededOperationIds = new Set(
				creationOperations
					.filter((operation) => operation.phase === "running")
					.map((operation) => operation.operationId),
			);
			set((s) => ({
				pendingCreationByChat: {
					...Object.fromEntries(
						Object.entries(s.pendingCreationByChat).filter(
							([, creation]) =>
								creation.projectId !== projectId ||
								!succeededOperationIds.has(creation.operationId),
						),
					),
					...Object.fromEntries(
						restored.map((pending) => [pending.chat.id, pending.creation]),
					),
				},
			}));
			overlayActiveEnvironmentShell((shell) => ({
				...shell,
				chatsByProject: {
					...shell.chatsByProject,
					[projectId]: restored.reduce(
						(list, pending) => upsertChat(list, pending.chat),
						shell.chatsByProject[projectId] ?? [],
					),
				},
				sessionsByProject: {
					...shell.sessionsByProject,
					[projectId]: restored.reduce(
						(list, pending) => upsertLatestEntity(list, pending.session),
						shell.sessionsByProject[projectId] ?? [],
					),
				},
			}));
			for (const pending of restored) {
				if (pending.creation.phase !== "failed") {
					void get().retryCreation(pending.chat.id, true);
				}
			}
			set((state) => ({
				loadingByProject: {
					...state.loadingByProject,
					[projectId]: false,
				},
			}));
		} catch (err) {
			const message = chatStoreErrorMessage(err);
			set((state) => ({
				loadingByProject: {
					...state.loadingByProject,
					[projectId]: false,
				},
				error: message,
			}));
		}
	},
	create: async (projectId, providerId, model, opts) => {
		const targetEnvironmentId = opts?.environmentId;
		if (
			targetEnvironmentId !== undefined &&
			targetEnvironmentId !== getActiveEnvironment()
		) {
			// Remote-targeted create: talk to the target computer directly and
			// touch NOTHING local — this desktop's stores describe the active
			// environment, and anything written here would be snapshotted away
			// by the follow-up switch anyway. The returned `remoteSeed` is
			// handed to `switchToEnvironment` so the chat is selectable the
			// moment the target environment activates.
			const remoteChatId =
				opts?.chatId ?? ChatId.make(`chat_${crypto.randomUUID()}`);
			const remoteSessionId =
				opts?.initialSessionId ?? SessionId.make(`s_${crypto.randomUUID()}`);
			const remoteOperationId =
				opts?.operationId ?? `create_${crypto.randomUUID()}`;
			const initialPrompt = opts?.startupInput?.text.trim();
			try {
				const commandId = nextChatCreateCommandId(remoteOperationId);
				const { result } = await dispatchChatCommand<unknown, ChatCreateResult>(
					{
						environmentId: targetEnvironmentId,
						kind: "chat.create",
						commandId,
						payload: {
							operationId: remoteOperationId,
							chatId: remoteChatId,
							initialSessionId: remoteSessionId,
							projectId,
							providerId,
							model,
							title: opts?.title,
							initialPrompt:
								initialPrompt === undefined || initialPrompt === ""
									? undefined
									: initialPrompt,
							runtimeMode: opts?.runtimeMode,
							permissionMode: opts?.permissionMode,
							toolSearch: opts?.toolSearch,
							background: true,
						},
						retry: "safe",
					},
				);
				const { chat, initialSession } = result;
				return {
					chatId: chat.id,
					initialSessionId: initialSession.id,
					worktreeId: chat.worktreeId,
					startupQueueId: null,
					remoteSeed: { chat, initialSession },
				};
			} catch (err) {
				set({ error: formatError(err) });
				return null;
			}
		}
		const chatId = opts?.chatId ?? ChatId.make(`chat_${crypto.randomUUID()}`);
		const initialSessionId =
			opts?.initialSessionId ?? SessionId.make(`s_${crypto.randomUUID()}`);
		const previousChatId = get().selectedChatByProject[projectId] ?? null;
		const previousSessionId =
			useSessionsStore.getState().selectedSessionByProject[projectId] ?? null;
		markRendererInteraction(initialSessionId, "click");
		const now = new Date();
		const title = opts?.title?.trim() || "New chat";
		const optimisticWorktreeId =
			opts?.worktreeId instanceof Promise ? null : (opts?.worktreeId ?? null);
		const optimisticChat = Chat.make({
			id: chatId,
			projectId,
			worktreeId: optimisticWorktreeId,
			title,
			titleProvenance: opts?.title?.trim() ? "manual" : "pending",
			activeSessionId: initialSessionId,
			originSessionId: null,
			archivedAt: null,
			lastMessageAt: null,
			lastReadAt: now,
			createdAt: now,
			updatedAt: now,
		});
		const optimisticSession = Session.make({
			id: initialSessionId,
			projectId,
			title,
			titleProvenance: opts?.title?.trim() ? "manual" : "pending",
			providerId,
			model,
			status: "booting",
			archivedAt: null,
			cursor: null,
			resumeStrategy: "none",
			runtimeMode: opts?.runtimeMode ?? "approval-required",
			worktreeId: optimisticWorktreeId,
			chatId,
			forkedFromSessionId: null,
			forkedFromMessageId: null,
			permissionMode: opts?.permissionMode ?? "default",
			toolSearch: opts?.toolSearch ?? false,
			createdAt: now,
			updatedAt: now,
		});
		const operationId = opts?.operationId ?? `create_${crypto.randomUUID()}`;
		const previousPending =
			opts?.reusePending === true
				? get().pendingCreationByChat[chatId]
				: undefined;
		const nextPending: PendingChatCreation = {
			operationId,
			chatId,
			sessionId: initialSessionId,
			projectId,
			providerId,
			model,
			title: opts?.title,
			runtimeMode: opts?.runtimeMode,
			permissionMode: opts?.permissionMode,
			toolSearch: opts?.toolSearch,
			startupInput: opts?.startupInput,
			startupReady: opts?.startupReady ?? true,
			prompt: opts?.startupInput?.text.trim() || null,
			workspaceRequested: opts?.workspaceRequested === true,
			worktreeId: optimisticWorktreeId,
			workspacePolicy:
				opts?.workspacePolicy instanceof Promise
					? null
					: (opts?.workspacePolicy ?? null),
			phase: "persisted",
			failureStage: null,
			retryable: true,
			attempts: { workspace: 0, setup: 0, provider: 0 },
			setupBypassed: false,
			error: null,
			previousChatId,
			previousSessionId,
			startupQueueId: opts?.startupQueueId ?? null,
			createdAt: now,
			startedAt: performance.now(),
		};
		const pendingCreation: PendingChatCreation =
			previousPending === undefined
				? nextPending
				: {
						...previousPending,
						workspacePolicy: nextPending.workspacePolicy,
						phase: previousPending.phase,
						error: null,
						startedAt: nextPending.startedAt,
					};
		let startupQueueId =
			opts?.startupQueueId ?? previousPending?.startupQueueId ?? null;
		batchAtomUpdates(() => {
			overlayActiveEnvironmentShell((shell) => ({
				...shell,
				chatsByProject: {
					...shell.chatsByProject,
					[projectId]: upsertChat(
						shell.chatsByProject[projectId] ?? [],
						optimisticChat,
					),
				},
				sessionsByProject: {
					...shell.sessionsByProject,
					[projectId]: upsertLatestEntity(
						shell.sessionsByProject[projectId] ?? [],
						optimisticSession,
					),
				},
			}));
			set((s) => ({
				error: null,
				creatingByProject: { ...s.creatingByProject, [projectId]: true },
				pendingCreationByChat: {
					...s.pendingCreationByChat,
					[chatId]: pendingCreation,
				},
				selectedChatId:
					opts?.preserveFocus === true ? s.selectedChatId : chatId,
				selectedChatByProject:
					opts?.preserveFocus === true
						? s.selectedChatByProject
						: {
								...s.selectedChatByProject,
								[projectId]: chatId,
							},
			}));
			useSessionsStore.setState((s) => ({
				selectedSessionId:
					opts?.preserveFocus === true ? s.selectedSessionId : initialSessionId,
				selectedSessionByProject:
					opts?.preserveFocus === true
						? s.selectedSessionByProject
						: {
								...s.selectedSessionByProject,
								[projectId]: initialSessionId,
							},
			}));
			if (
				opts?.startupInput !== undefined &&
				chatStartupUsesQueue(opts?.startupInput, opts?.startupReady ?? true) &&
				opts?.reusePending !== true
			) {
				startupQueueId = queueSessionMessage(
					{
						environmentId: EnvironmentId.make(getActiveEnvironment()),
						sessionId: initialSessionId,
					},
					opts.startupInput,
					{ persist: false },
				);
			}
		});
		if (startupQueueId !== null) {
			set((s) => ({
				pendingCreationByChat: {
					...s.pendingCreationByChat,
					[chatId]: {
						...(s.pendingCreationByChat[chatId] ?? pendingCreation),
						startupQueueId,
					},
				},
			}));
		}
		markRendererInteraction(initialSessionId, "first-atom-commit");
		const environmentId = EnvironmentId.make(getActiveEnvironment());
		const commandId = nextChatCreateCommandId(operationId);
		let knownWorktreeId = optimisticWorktreeId;
		try {
			const workspacePolicy = await opts?.workspacePolicy;
			const worktreeId = await (opts?.worktreeId ?? null);
			knownWorktreeId =
				workspacePolicy?._tag === "existing"
					? workspacePolicy.worktreeId
					: worktreeId;
			set((s) => ({
				pendingCreationByChat: {
					...s.pendingCreationByChat,
					[chatId]: {
						...(s.pendingCreationByChat[chatId] ?? pendingCreation),
						worktreeId: knownWorktreeId,
						workspacePolicy: workspacePolicy ?? null,
						workspaceRequested:
							workspacePolicy === undefined
								? (s.pendingCreationByChat[chatId] ?? pendingCreation)
										.workspaceRequested
								: workspacePolicy._tag !== "main",
					},
				},
			}));
			overlayActiveEnvironmentShell((shell) => ({
				...shell,
				chatsByProject: {
					...shell.chatsByProject,
					[projectId]: (shell.chatsByProject[projectId] ?? []).map((row) =>
						row.id === chatId
							? Chat.make({ ...row, worktreeId: knownWorktreeId })
							: row,
					),
				},
				sessionsByProject: {
					...shell.sessionsByProject,
					[projectId]: (shell.sessionsByProject[projectId] ?? []).map((row) =>
						row.id === initialSessionId
							? Session.make({ ...row, worktreeId: knownWorktreeId })
							: row,
					),
				},
			}));
			const { result } = await dispatchChatCommand<unknown, ChatCreateResult>({
				kind: "chat.create",
				commandId,
				payload: {
					operationId,
					chatId,
					initialSessionId,
					projectId,
					providerId,
					model,
					title: opts?.title,
					runtimeMode: opts?.runtimeMode,
					worktreeId,
					workspacePolicy,
					startupInput: opts?.startupInput,
					startupQueueId: startupQueueId ?? undefined,
					startupReady: opts?.startupReady ?? true,
					permissionMode: opts?.permissionMode,
					toolSearch: opts?.toolSearch,
					background: true,
				},
				retry: "safe",
			});
			markRendererInteraction(initialSessionId, "entity-acknowledged");
			const { chat, initialSession } = result;
			overlayActiveEnvironmentShell((shell) => ({
				...shell,
				chatsByProject: {
					...shell.chatsByProject,
					[projectId]: upsertChat(shell.chatsByProject[projectId] ?? [], chat),
				},
				sessionsByProject: {
					...shell.sessionsByProject,
					[projectId]: upsertLatestEntity(
						shell.sessionsByProject[projectId] ?? [],
						initialSession,
					),
				},
			}));
			// Refresh the worktree projection without gating the acknowledged chat.
			// This side request can be delayed independently of chat creation; awaiting
			// it leaves the provisional setup surface mounted while the real turn runs
			// behind it, so the transcript only appears after a navigation remount.
			if (chat.worktreeId !== null) {
				void useWorktreesStore.getState().refresh(projectId);
			}
			// Land the new chat in front of the project's existing list and
			// mark it active so the renderer immediately swaps to it.
			set((s) => {
				const stillOwnsSelection =
					s.selectedChatId === chatId &&
					s.selectedChatByProject[projectId] === chatId;
				return {
					selectedChatId: stillOwnsSelection ? chat.id : s.selectedChatId,
					selectedChatByProject: stillOwnsSelection
						? { ...s.selectedChatByProject, [projectId]: chat.id }
						: s.selectedChatByProject,
					creatingByProject: {
						...s.creatingByProject,
						[projectId]: false,
					},
					pendingCreationByChat: {
						...s.pendingCreationByChat,
						[chatId]: {
							...(s.pendingCreationByChat[chatId] ?? pendingCreation),
							worktreeId: chat.worktreeId,
						},
					},
				};
			});
			// Mirror the initial session into the sessions store and select it
			// so the chat surface (composer, message list, cost footer) wires up
			// on the very next render.
			useSessionsStore.setState((s) => {
				const stillOwnsSelection =
					s.selectedSessionId === initialSessionId &&
					s.selectedSessionByProject[projectId] === initialSessionId;
				// The live chat stream can hydrate this row before create() resolves.
				// Deduplicate the row without dropping the selection transition.
				return {
					selectedSessionId: stillOwnsSelection
						? initialSession.id
						: s.selectedSessionId,
					selectedSessionByProject: stillOwnsSelection
						? {
								...s.selectedSessionByProject,
								[projectId]: initialSession.id,
							}
						: s.selectedSessionByProject,
				};
			});
			restartSessionTimeline({ environmentId, sessionId: initialSession.id });
			return {
				chatId: chat.id,
				initialSessionId: initialSession.id,
				worktreeId: chat.worktreeId,
				startupQueueId,
			};
		} catch (err) {
			const reportableError = chatStoreErrorMessage(err);
			if (reportableError === null) {
				// Replacing a retained stream interrupts the in-flight RPC fiber. The
				// durable command/outbox remains authoritative, so keep the optimistic
				// chat selected while its creation projection catches up.
				set((s) => ({
					error: null,
					creatingByProject: {
						...s.creatingByProject,
						[projectId]: false,
					},
				}));
				return {
					chatId,
					initialSessionId,
					worktreeId: knownWorktreeId,
					startupQueueId,
				};
			}
			const reason = reportableError;
			const retryable = getRendererClientBus()
				.snapshot(
					environmentShellResourceKey({
						environmentId,
					}),
				)
				.failedCommands.some(
					(command) => command.commandId === commandId && command.retryable,
				);
			if (retryable) {
				// Transport interruption does not reject a retry-safe creation. Keep
				// its provisional shell and durable outbox entry until replay or the
				// creation-status stream supplies an authoritative outcome.
				set((s) => ({
					error: null,
					creatingByProject: {
						...s.creatingByProject,
						[projectId]: false,
					},
				}));
				return {
					chatId,
					initialSessionId,
					worktreeId: knownWorktreeId,
					startupQueueId,
				};
			}
			batchAtomUpdates(() => {
				overlayActiveEnvironmentShell((shell) => ({
					...shell,
					sessionsByProject: {
						...shell.sessionsByProject,
						[projectId]: (shell.sessionsByProject[projectId] ?? []).map(
							(row) =>
								row.id === initialSessionId
									? Session.make({ ...row, status: "error" })
									: row,
						),
					},
				}));
				set((s) => ({
					error: reason,
					pendingCreationByChat: {
						...s.pendingCreationByChat,
						[chatId]: {
							...(s.pendingCreationByChat[chatId] ?? pendingCreation),
							phase: "failed",
							failureStage: "configuration",
							error: reason,
							startupQueueId:
								s.pendingCreationByChat[chatId]?.startupQueueId ??
								startupQueueId,
						},
					},
					creatingByProject: { ...s.creatingByProject, [projectId]: false },
				}));
			});
			return null;
		}
	},
	retryCreation: async (chatId, preserveFocus = false) => {
		const creation = get().pendingCreationByChat[chatId];
		if (
			creation === undefined ||
			(creation.phase !== "failed" && preserveFocus !== true)
		)
			return false;
		const existing = creationRetryPromises.get(creation.operationId);
		if (existing !== undefined) return existing;
		const retry = (async () => {
			if (creation.phase === "failed" && creation.failureStage !== null) {
				const action =
					creation.failureStage === "workspace"
						? "retry_workspace"
						: creation.failureStage === "setup"
							? "retry_setup"
							: creation.failureStage === "provider"
								? "retry_agent"
								: null;
				if (action === null || !creation.retryable) return false;
				const expectedAttempt =
					creation.failureStage === "workspace"
						? creation.attempts.workspace
						: creation.failureStage === "setup"
							? creation.attempts.setup
							: creation.attempts.provider;
				const { result: recovered } = await dispatchChatCommand<
					unknown,
					ChatCreationOperation
				>({
					kind: "chat.creation.recover",
					payload: {
						operationId: creation.operationId,
						action,
						expectedPhase: creation.phase,
						expectedFailureStage: creation.failureStage,
						expectedAttempt,
					},
				});
				const restored = restorePendingCreation(recovered).creation;
				set((state) => ({
					pendingCreationByChat: {
						...state.pendingCreationByChat,
						[chatId]: { ...creation, ...restored },
					},
				}));
				if (recovered.phase === "failed") return false;
			}
			const result = await get().create(
				creation.projectId,
				creation.providerId,
				creation.model,
				{
					operationId: creation.operationId,
					chatId: creation.chatId,
					initialSessionId: creation.sessionId,
					reusePending: true,
					preserveFocus,
					title: creation.title,
					runtimeMode: creation.runtimeMode,
					permissionMode: creation.permissionMode,
					toolSearch: creation.toolSearch,
					startupInput: creation.startupInput,
					startupQueueId: creation.startupQueueId ?? undefined,
					startupReady: creation.startupReady,
					workspaceRequested: creation.workspaceRequested,
					workspacePolicy:
						creation.workspacePolicy ??
						(creation.workspaceRequested
							? { _tag: "fresh" }
							: { _tag: "main" }),
				},
			);
			return result !== null;
		})();
		creationRetryPromises.set(creation.operationId, retry);
		try {
			return await retry;
		} finally {
			if (creationRetryPromises.get(creation.operationId) === retry) {
				creationRetryPromises.delete(creation.operationId);
			}
		}
	},
	continueCreation: async (chatId) => {
		const creation = get().pendingCreationByChat[chatId];
		if (
			creation === undefined ||
			creation.phase !== "failed" ||
			creation.failureStage !== "setup" ||
			!creation.retryable
		) {
			return false;
		}
		const { result: recovered } = await dispatchChatCommand<
			unknown,
			ChatCreationOperation
		>({
			kind: "chat.creation.recover",
			payload: {
				operationId: creation.operationId,
				action: "continue_anyway",
				expectedPhase: creation.phase,
				expectedFailureStage: creation.failureStage,
				expectedAttempt: creation.attempts.setup,
			},
		});
		const restored = restorePendingCreation(recovered).creation;
		set((state) => ({
			pendingCreationByChat: {
				...state.pendingCreationByChat,
				[chatId]: { ...creation, ...restored },
			},
		}));
		if (recovered.phase === "failed") return false;
		return get().retryCreation(chatId, true);
	},
	completeCreation: (chatId) => {
		const creation = get().pendingCreationByChat[chatId];
		if (creation === undefined) return;
		set((state) => ({
			creatingByProject: {
				...state.creatingByProject,
				[creation.projectId]: false,
			},
			pendingCreationByChat: Object.fromEntries(
				Object.entries(state.pendingCreationByChat).filter(
					([id]) => id !== chatId,
				),
			),
		}));
	},
	discardCreation: (chatId) => {
		const creation = get().pendingCreationByChat[chatId];
		if (creation === undefined) return;
		const ref = activeChatRef(chatId);
		void (async () => {
			try {
				await dispatchChatCommand({
					kind: "chat.creation.discard",
					payload: { operationId: creation.operationId },
				});
			} catch {
				// Local discard remains responsive; a reconnect list can reconcile
				// the durable operation if the server did not receive this request.
			}
		})();
		if (creation.startupQueueId !== null) {
			dropQueuedMessage(
				{
					environmentId: EnvironmentId.make(getActiveEnvironment()),
					sessionId: creation.sessionId,
				},
				creation.startupQueueId,
			);
		}
		overlayActiveEnvironmentShell((shell) => ({
			...shell,
			chatsByProject: {
				...shell.chatsByProject,
				[creation.projectId]: (
					shell.chatsByProject[creation.projectId] ?? []
				).filter((chat) => chat.id !== chatId),
			},
			sessionsByProject: {
				...shell.sessionsByProject,
				[creation.projectId]: (
					shell.sessionsByProject[creation.projectId] ?? []
				).filter((session) => session.id !== creation.sessionId),
			},
		}));
		useSessionsStore.setState((s) => ({
			selectedSessionId:
				s.selectedSessionId === creation.sessionId
					? creation.previousSessionId
					: s.selectedSessionId,
			selectedSessionByProject: {
				...s.selectedSessionByProject,
				[creation.projectId]:
					s.selectedSessionByProject[creation.projectId] === creation.sessionId
						? creation.previousSessionId
						: (s.selectedSessionByProject[creation.projectId] ?? null),
			},
		}));
		set((s) => ({
			pendingCreationByChat: Object.fromEntries(
				Object.entries(s.pendingCreationByChat).filter(([id]) => id !== chatId),
			),
			selectedChatId:
				s.selectedChatId === creation.chatId
					? creation.previousChatId
					: s.selectedChatId,
			selectedChatByProject: {
				...s.selectedChatByProject,
				[creation.projectId]:
					s.selectedChatByProject[creation.projectId] === creation.chatId
						? creation.previousChatId
						: (s.selectedChatByProject[creation.projectId] ?? null),
			},
		}));
		useTerminalsStore.getState().disposeChat(ref);
		useUiStore.getState().clearChatPanels(ref);
	},
	rename: async (chatId, title) => {
		set({ error: null });
		try {
			const cloud = cloudSummaryForChat(chatId);
			const { result: renamed } = await dispatchChatCommand<
				{ readonly chatId: ChatId; readonly title: string },
				Chat
			>({
				environmentId: cloud?.workspaceId,
				kind: "chat.rename",
				payload: { chatId, title },
			});
			overlayActiveEnvironmentShell((shell) => {
				const projectId = findChatProject(shell.chatsByProject, chatId);
				if (projectId === null) return undefined;
				return {
					...shell,
					chatsByProject: {
						...shell.chatsByProject,
						[projectId]: (shell.chatsByProject[projectId] ?? []).map((chat) =>
							chat.id === chatId ? renamed : chat,
						),
					},
				};
			});
		} catch (err) {
			set({ error: formatError(err) });
			throw err;
		}
	},
	setWorktree: async (chatId, worktreeId) => {
		set({ error: null });
		try {
			const { result: chat } = await dispatchChatCommand<
				{ readonly chatId: ChatId; readonly worktreeId: WorktreeId | null },
				Chat
			>({
				kind: "chat.setWorktree",
				payload: { chatId, worktreeId },
			});
			// Mirror the worktree change onto every member session in the
			// renderer cache; the server has already updated the DB rows.
			overlayActiveEnvironmentShell((shell) => {
				const projectId = findChatProject(shell.chatsByProject, chatId);
				if (projectId === null) return undefined;
				return {
					...shell,
					chatsByProject: {
						...shell.chatsByProject,
						[projectId]: (shell.chatsByProject[projectId] ?? []).map((row) =>
							row.id === chatId ? chat : row,
						),
					},
					sessionsByProject: {
						...shell.sessionsByProject,
						[projectId]: (shell.sessionsByProject[projectId] ?? []).map(
							(row): Session =>
								row.chatId === chatId ? { ...row, worktreeId } : row,
						),
					},
				};
			});
			return { ok: true } as const;
		} catch (err) {
			const reason = formatError(err);
			set({ error: reason });
			return { ok: false, reason } as const;
		}
	},
	setActiveSession: async (chatId, sessionId) => {
		// Optimistic — patch local state first so the sidebar's last-active
		// memo is immediate. Server reconciles on success; on failure we just
		// log via `error`.
		overlayActiveEnvironmentShell((shell) => {
			const projectId = findChatProject(shell.chatsByProject, chatId);
			if (projectId === null) return undefined;
			return {
				...shell,
				chatsByProject: {
					...shell.chatsByProject,
					[projectId]: (shell.chatsByProject[projectId] ?? []).map((c) =>
						c.id === chatId
							? Object.assign(Object.create(Object.getPrototypeOf(c)), c, {
									activeSessionId: sessionId,
								})
							: c,
					),
				},
			};
		});
		// Cloud chat/session selection is projected from the control plane. The
		// sandbox-local conversation row may not exist while compute is paused,
		// so selecting a durable transcript must never issue this local RPC.
		if (cloudSummaryForChat(chatId) !== null) return;
		try {
			await dispatchChatCommand({
				kind: "chat.setActiveSession",
				payload: { chatId, sessionId },
			});
		} catch (err) {
			set({ error: formatError(err) });
		}
	},
	archive: async (chatId, force = false) => {
		const ref = activeChatRef(chatId);
		set((state) => ({
			error: null,
			hiddenArchivedChatIds: new Set(state.hiddenArchivedChatIds).add(chatId),
		}));
		const provisional = get().pendingCreationByChat[chatId];
		if (provisional?.phase === "failed") {
			get().discardCreation(chatId);
			return { ok: true } as const;
		}
		const cloudSummary = cloudSummaryForChat(chatId);
		if (cloudSummary !== null) {
			try {
				const { useCloudChatsStore } = await import(
					"../lib/cloud-workspaces.ts"
				);
				await useCloudChatsStore.getState().archive(cloudSummary);
				return { ok: true } as const;
			} catch (cause) {
				const reason = formatError(cause);
				set((state) => {
					const hiddenArchivedChatIds = new Set(state.hiddenArchivedChatIds);
					hiddenArchivedChatIds.delete(chatId);
					return { error: reason, hiddenArchivedChatIds };
				});
				toastManager.add({
					type: "error",
					title: "Cloud chat could not be archived",
					description: reason,
				});
				return { ok: false, reason } as const;
			}
		}
		const projectIdBeforeArchive = findChatProject(
			activeChatsByProject(),
			chatId,
		);
		const selectedAtStart = get().selectedChatId === chatId;
		const liveChatsBefore =
			projectIdBeforeArchive === null
				? []
				: (activeChatsByProject()[projectIdBeforeArchive] ?? []).filter(
						(chat) => chat.archivedAt === null,
					);
		const archivedIndex = liveChatsBefore.findIndex(
			(chat) => chat.id === chatId,
		);
		const fallbackChatId =
			archivedIndex < 0
				? null
				: (liveChatsBefore[archivedIndex + 1]?.id ??
					liveChatsBefore[archivedIndex - 1]?.id ??
					null);
		const chatsSnapshot =
			projectIdBeforeArchive === null
				? null
				: (activeChatsByProject()[projectIdBeforeArchive] ?? []);
		const sessionsState = useSessionsStore.getState();
		const sessionsSnapshot =
			projectIdBeforeArchive === null
				? null
				: (activeSessionsByProject()[projectIdBeforeArchive] ?? []);
		const selectedSessionSnapshot = sessionsState.selectedSessionId;
		const failedChatSnapshot = chatsSnapshot?.find(
			(candidate) => candidate.id === chatId,
		);
		const failedSessionSnapshots =
			sessionsSnapshot?.filter((candidate) => candidate.chatId === chatId) ??
			[];
		if (projectIdBeforeArchive !== null) {
			overlayActiveEnvironmentShell((shell) => ({
				...shell,
				chatsByProject: {
					...shell.chatsByProject,
					[projectIdBeforeArchive]: (
						shell.chatsByProject[projectIdBeforeArchive] ?? []
					).filter((chat) => chat.id !== chatId),
				},
				sessionsByProject: {
					...shell.sessionsByProject,
					[projectIdBeforeArchive]: (
						shell.sessionsByProject[projectIdBeforeArchive] ?? []
					).filter((row) => row.chatId !== chatId),
				},
			}));
			if (selectedAtStart) get().select(fallbackChatId);
		}
		let result: ChatArchiveResult;
		try {
			const receipt = await dispatchChatCommand<
				{ readonly chatId: ChatId; readonly force?: boolean },
				ChatArchiveResult
			>({
				kind: "chat.archive",
				payload: { chatId, ...(force ? { force: true } : {}) },
			});
			result = receipt.result;
		} catch (err) {
			const reason = formatError(err);
			let reconciled: ChatArchiveResult | null = null;
			let definitiveFailure = false;
			try {
				const [chatReceipt, jobReceipt] = await Promise.all([
					dispatchChatCommand<{ readonly chatId: ChatId }, Chat>({
						kind: "chat.get",
						payload: { chatId },
					}),
					dispatchChatCommand<
						{ readonly chatId: ChatId },
						ChatArchiveJob | null
					>({ kind: "chat.archiveStatus", payload: { chatId } }),
				]);
				const chat = chatReceipt.result;
				const job = jobReceipt.result;
				if (chat.archivedAt !== null) {
					reconciled = { chat, checkpoint: null, job };
				} else {
					definitiveFailure = true;
				}
			} catch {
				// A disconnect after commit is ambiguous. Reconcile on hydration and do
				// not offer a destructive override until the server answers definitively.
			}
			if (reconciled !== null) {
				result = reconciled;
			} else {
				set((state) => {
					const hiddenArchivedChatIds = new Set(state.hiddenArchivedChatIds);
					hiddenArchivedChatIds.delete(chatId);
					return { hiddenArchivedChatIds };
				});
				const shouldRestoreSelection =
					selectedAtStart && get().selectedChatId === fallbackChatId;
				if (
					projectIdBeforeArchive !== null &&
					failedChatSnapshot !== undefined
				) {
					set({ error: reason });
					if (failedSessionSnapshots.length > 0) {
						overlayActiveEnvironmentShell((shell) => ({
							...shell,
							chatsByProject: {
								...shell.chatsByProject,
								[projectIdBeforeArchive]: upsertChat(
									shell.chatsByProject[projectIdBeforeArchive] ?? [],
									failedChatSnapshot,
								),
							},
							sessionsByProject: {
								...shell.sessionsByProject,
								[projectIdBeforeArchive]: [
									...failedSessionSnapshots,
									...(
										shell.sessionsByProject[projectIdBeforeArchive] ?? []
									).filter((candidate) => candidate.chatId !== chatId),
								],
							},
						}));
						useSessionsStore.setState((s) => ({
							selectedSessionId: shouldRestoreSelection
								? selectedSessionSnapshot
								: s.selectedSessionId,
						}));
					}
					if (shouldRestoreSelection) get().select(chatId);
				} else {
					set({ error: reason });
				}
				toastManager.add({
					type: "error",
					title: definitiveFailure
						? force
							? "Force archive failed"
							: "Archive failed"
						: "Archive status unavailable",
					description: reason,
					...(force || !definitiveFailure
						? {}
						: {
								actionProps: {
									children: "Force archive",
									onClick: () => void get().archive(chatId, true),
								},
							}),
				});
				return { ok: false, reason } as const;
			}
		}

		// The RPC is the commit point. Reconcile every local store synchronously
		// before starting optional refresh work so the archived live view cannot
		// linger or turn a successful mutation into a reported failure.
		const projectId = projectIdBeforeArchive ?? result.chat.projectId;
		useArchivePreviewStore.getState().upsertChat(result.chat);
		if (result.job?.status === "queued" || result.job?.status === "running") {
			notifiedArchiveFailures.delete(chatId);
			monitorArchiveJob(chatId);
		}
		const projectSessions = activeSessionsByProject()[projectId] ?? [];
		overlayActiveEnvironmentShell((shell) => ({
			...shell,
			chatsByProject: {
				...shell.chatsByProject,
				[projectId]: (shell.chatsByProject[projectId] ?? []).filter(
					(chat) => chat.id !== chatId,
				),
			},
			sessionsByProject: {
				...shell.sessionsByProject,
				[projectId]: (shell.sessionsByProject[projectId] ?? []).filter(
					(row) => row.chatId !== chatId,
				),
			},
		}));
		useSessionsStore.setState((s) => {
			return {
				selectedSessionId:
					s.selectedSessionId !== null &&
					projectSessions.find((row) => row.id === s.selectedSessionId)
						?.chatId === chatId
						? null
						: s.selectedSessionId,
			};
		});
		if (selectedAtStart && get().selectedChatId === chatId) {
			get().select(fallbackChatId);
		}
		useTerminalsStore.getState().disposeChat(ref);
		useUiStore.getState().clearChatPanels(ref);
		void get().hydrate(projectId);
		void useWorktreesStore.getState().refresh(projectId);
		return { ok: true } as const;
	},
	setArchiveProgress: (chatId, phase) => {
		set((s) => ({
			archiveProgressByChat: {
				...s.archiveProgressByChat,
				[chatId]: phase,
			},
		}));
	},
	clearArchiveProgress: (chatId) => {
		set((s) => {
			if (s.archiveProgressByChat[chatId] === undefined) return s;
			const next = { ...s.archiveProgressByChat };
			delete next[chatId];
			return { archiveProgressByChat: next };
		});
	},
	unarchive: (chatId) => {
		const pending = unarchivePromises.get(chatId);
		if (pending !== undefined) return pending;
		const run = (async (): Promise<ChatUnarchiveOutcome> => {
			set({ error: null });
			const archives = useArchivePreviewStore.getState();
			archives.setRestoring(chatId, true);
			archives.setRestoreError(chatId, null);
			try {
				const cloud = cloudSummaryForChat(chatId);
				if (cloud !== null) {
					const cloudWorkspaceModule = await import(
						"../lib/cloud-workspaces.ts"
					);
					const projectId =
						cloudWorkspaceModule.localProjectForCloudChat(chatId);
					if (projectId === null)
						throw new Error("Cloud chat project is not available.");
					const optimisticSummary = optimisticallyUnarchiveCloudChat(cloud);
					cloudWorkspaceModule.stageCloudChat(optimisticSummary, projectId);
					archives.removeChat(chatId, projectId);
					set((state) => {
						const hiddenArchivedChatIds = new Set(state.hiddenArchivedChatIds);
						hiddenArchivedChatIds.delete(chatId);
						return { hiddenArchivedChatIds };
					});
					get().select(chatId);
					const [{ runControlPlane }, cloudChats] = await Promise.all([
						import("../lib/control-plane-client.ts"),
						import("../lib/cloud-workspaces.ts"),
					]);
					const workspace = await runControlPlane((control) =>
						control["cloud.workspaces.unarchive"]({
							workspaceId: cloud.workspaceId,
							commandId: crypto.randomUUID(),
						}),
					);
					const restoredSummary = {
						...cloud,
						state: workspace.state,
						desiredState: workspace.desiredState,
						runtimeState: workspace.runtimeState,
						statusCode: workspace.statusCode,
						failureDiagnostic: workspace.failureDiagnostic,
						startupPhase: workspace.startupPhase,
						revision: workspace.revision,
						updatedAt: workspace.updatedAt,
						archivedAt: undefined,
					};
					cloudChats.stageCloudChat(restoredSummary, projectId);
					const shell = activeChatsByProject();
					const chat = shell[projectId]?.find(
						(candidate) => candidate.id === chatId,
					);
					const sessions = activeSessionsByProject()[projectId]?.filter(
						(session) => session.chatId === chatId,
					);
					if (chat === undefined || sessions === undefined)
						throw new Error("Cloud chat projection is not available.");
					return {
						ok: true,
						chat,
						sessions,
						worktree: null,
						directoryStatus: { _tag: "available" },
					} as const;
				}
				const { result } = await dispatchChatCommand<
					{ readonly chatId: ChatId },
					ChatUnarchiveResult
				>({ kind: "chat.unarchive", payload: { chatId } });
				const projectId = findChatProject(activeChatsByProject(), chatId);
				const resolvedProjectId = projectId ?? result.chat.projectId;
				set((s) => {
					const hiddenArchivedChatIds = new Set(s.hiddenArchivedChatIds);
					hiddenArchivedChatIds.delete(chatId);
					return {
						selectedChatId: result.chat.id,
						hiddenArchivedChatIds,
						selectedChatByProject: {
							...s.selectedChatByProject,
							[resolvedProjectId]: result.chat.id,
						},
					};
				});
				overlayActiveEnvironmentShell((shell) => {
					const existing = shell.sessionsByProject[resolvedProjectId] ?? [];
					const restoredIds = new Set(result.sessions.map((row) => row.id));
					return {
						...shell,
						chatsByProject: {
							...shell.chatsByProject,
							[resolvedProjectId]: upsertChat(
								shell.chatsByProject[resolvedProjectId] ?? [],
								result.chat,
							),
						},
						sessionsByProject: {
							...shell.sessionsByProject,
							[resolvedProjectId]: [
								...result.sessions,
								...existing.filter((row) => !restoredIds.has(row.id)),
							],
						},
					};
				});
				useSessionsStore.setState((s) => {
					const restoredIds = new Set(result.sessions.map((row) => row.id));
					const landingId =
						result.chat.activeSessionId !== null &&
						restoredIds.has(result.chat.activeSessionId)
							? result.chat.activeSessionId
							: (result.sessions[0]?.id ?? null);
					return {
						selectedSessionId: landingId ?? s.selectedSessionId,
						selectedSessionByProject: {
							...s.selectedSessionByProject,
							[resolvedProjectId]: landingId,
						},
					};
				});
				useArchivePreviewStore.getState().removeChat(chatId, resolvedProjectId);
				useUiStore.getState().setActiveMainTab("chat");
				if (result.worktree !== null) {
					void useWorktreesStore.getState().refresh(resolvedProjectId);
					useWorktreesStore
						.getState()
						.subscribeSetup(resolvedProjectId, result.worktree.id);
				}
				if (result.restoreNotice === "branch-advanced") {
					toastManager.add({
						type: "warning",
						title: "Branch changed while archived",
						description:
							"The worktree was restored at the latest branch tip. Archived changes remain safely stored for recovery.",
					});
				}
				return { ok: true, ...result } as const;
			} catch (err) {
				const reason = formatError(err);
				set({ error: reason });
				useArchivePreviewStore.getState().setRestoreError(chatId, reason);
				return { ok: false, reason } as const;
			} finally {
				useArchivePreviewStore.getState().setRestoring(chatId, false);
				unarchivePromises.delete(chatId);
			}
		})();
		unarchivePromises.set(chatId, run);
		return run;
	},
	remove: async (chatId) => {
		const ref = activeChatRef(chatId);
		const cloud = cloudSummaryForChat(chatId);
		set({ error: null });
		if (get().pendingCreationByChat[chatId]?.phase === "failed") {
			get().discardCreation(chatId);
			return;
		}
		try {
			if (cloud === null) {
				await dispatchChatCommand({
					kind: "chat.delete",
					payload: { chatId },
				});
			} else {
				const [{ runControlPlane }, catalog] = await Promise.all([
					import("../lib/control-plane-client.ts"),
					import("../lib/cloud-workspace-catalog.ts"),
				]);
				await runControlPlane((control) =>
					control["cloud.workspaces.delete"]({
						workspaceId: cloud.workspaceId,
						commandId: crypto.randomUUID(),
					}),
				);
				catalog.forgetCloudChat(cloud.workspaceId);
			}
			const projectId = findChatProject(activeChatsByProject(), chatId);
			set((s) => {
				if (projectId === null) return {};
				const perProject =
					s.selectedChatByProject[projectId] === chatId
						? { ...s.selectedChatByProject, [projectId]: null }
						: s.selectedChatByProject;
				return {
					selectedChatId: s.selectedChatId === chatId ? null : s.selectedChatId,
					selectedChatByProject: perProject,
				};
			});
			// Drop the chat's sessions from the renderer cache. The server has
			// cascaded the rows; this just keeps the UI in lockstep without a
			// re-hydrate round-trip.
			const projectSessions =
				projectId === null ? [] : (activeSessionsByProject()[projectId] ?? []);
			const deletedSessions = projectSessions.filter(
				(session) => session.chatId === chatId,
			);
			const cacheEnvironmentId =
				cloud === null
					? ref.environmentId
					: EnvironmentId.make(cloud.workspaceId);
			await Promise.all(
				deletedSessions.flatMap((session) => {
					const sessionRef = {
						environmentId: cacheEnvironmentId,
						sessionId: session.id,
					};
					return [
						sessionTimelineCache?.remove(sessionRef),
						timelineReadingPositionStore?.remove(sessionRef),
					];
				}),
			);
			overlayActiveEnvironmentShell((shell) =>
				projectId === null
					? undefined
					: {
							...shell,
							chatsByProject: {
								...shell.chatsByProject,
								[projectId]: (shell.chatsByProject[projectId] ?? []).filter(
									(chat) => chat.id !== chatId,
								),
							},
							sessionsByProject: {
								...shell.sessionsByProject,
								[projectId]: (shell.sessionsByProject[projectId] ?? []).filter(
									(row) => row.chatId !== chatId,
								),
							},
						},
			);
			useSessionsStore.setState((s) => {
				if (projectId === null) return s;
				return {
					selectedSessionId:
						s.selectedSessionId !== null &&
						projectSessions.find((row) => row.id === s.selectedSessionId)
							?.chatId === chatId
							? null
							: s.selectedSessionId,
				};
			});
			// Dispose the deleted chat's terminals (closing their PTYs) and drop its
			// dock layout so nothing lingers after the chat is gone.
			useTerminalsStore.getState().disposeChat(ref);
			useUiStore.getState().clearChatPanels(ref);
		} catch (err) {
			set({ error: formatError(err) });
		}
	},
	select: (chatId) => {
		if (chatId === null) {
			set((s) => {
				const projectId = useWorkspaceStore.getState().selectedFolderId;
				return {
					selectedChatId: null,
					selectedChatByProject:
						projectId !== null
							? { ...s.selectedChatByProject, [projectId]: null }
							: s.selectedChatByProject,
				};
			});
			useSessionsStore.getState().select(null);
			return;
		}
		const chatsByProject = activeChatsByProject();
		const projectId = findChatProject(chatsByProject, chatId);
		useUiStore.getState().setActiveMainTab("chat");
		set((s) => ({
			selectedChatId: chatId,
			selectedChatByProject:
				projectId !== null
					? { ...s.selectedChatByProject, [projectId]: chatId }
					: s.selectedChatByProject,
		}));
		if (
			projectId !== null &&
			useWorkspaceStore.getState().selectedFolderId !== projectId
		) {
			void useWorkspaceStore.getState().select(projectId);
		}
		// Land on the chat's last-active live tab, or another live tab when that
		// memo is stale. An active chat with no live tabs is interrupted legacy
		// state, so explicitly restore its persisted active tab below.
		const chat = chatsByProject[projectId ?? ""]?.find((c) => c.id === chatId);
		if (chat === undefined) return;
		const projectSessions =
			projectId === null ? [] : (activeSessionsByProject()[projectId] ?? []);
		const liveTabs = projectSessions.filter(
			(row) => row.chatId === chatId && row.archivedAt === null,
		);
		const selection = resolveChatSessionSelection(
			chat.activeSessionId,
			liveTabs,
		);
		useSessionsStore.getState().select(selection.sessionId);
		if (selection.recoverArchivedSessionId !== null && projectId !== null) {
			void recoverArchivedActiveSession(
				chat.id,
				projectId,
				selection.recoverArchivedSessionId,
			);
		}
		// Viewing a chat marks it read. `markRead` no-ops for archived chats.
		void get().markRead(chatId);
	},
	markRead: async (chatId) => {
		if (cloudSummaryForChat(chatId) !== null) return;
		const chatsByProject = activeChatsByProject();
		const projectId = findChatProject(chatsByProject, chatId);
		if (projectId === null) return;
		const chat = (chatsByProject[projectId] ?? []).find((c) => c.id === chatId);
		if (chat === undefined || chat.archivedAt !== null) return;
		// Already read and no fresh activity — skip the round-trip.
		if (!isChatUnread(chat, null)) return;
		const now = new Date();
		const patch = (target: Chat, lastReadAt: Date): Chat =>
			Object.assign(Object.create(Object.getPrototypeOf(target)), target, {
				lastReadAt,
			});
		overlayActiveEnvironmentShell((shell) => ({
			...shell,
			chatsByProject: {
				...shell.chatsByProject,
				[projectId]: (shell.chatsByProject[projectId] ?? []).map((chat) =>
					chat.id === chatId ? patch(chat, now) : chat,
				),
			},
		}));
		try {
			const { result: updated } = await dispatchChatCommand<
				{ readonly chatId: ChatId },
				Chat
			>({ kind: "chat.markRead", payload: { chatId } });
			overlayActiveEnvironmentShell((shell) => ({
				...shell,
				chatsByProject: {
					...shell.chatsByProject,
					[projectId]: (shell.chatsByProject[projectId] ?? []).map((chat) =>
						chat.id === chatId ? updated : chat,
					),
				},
			}));
		} catch (err) {
			// Non-fatal — the optimistic stamp already cleared the unread style.
			set({ error: formatError(err) });
		}
	},
	noteChatActivity: (chatId) => {
		overlayActiveEnvironmentShell((shell) => {
			const projectId = findChatProject(shell.chatsByProject, chatId);
			if (projectId === null) return undefined;
			const now = new Date();
			return {
				...shell,
				chatsByProject: {
					...shell.chatsByProject,
					[projectId]: (shell.chatsByProject[projectId] ?? []).map((c) =>
						c.id === chatId
							? Object.assign(Object.create(Object.getPrototypeOf(c)), c, {
									lastMessageAt: now,
								})
							: c,
					),
				},
			};
		});
	},
}));

registerChatCommands({
	upsertFork: (chat, session) => {
		overlayActiveEnvironmentShell((shell) => ({
			...shell,
			chatsByProject: {
				...shell.chatsByProject,
				[session.projectId]: upsertChat(
					shell.chatsByProject[session.projectId] ?? [],
					chat,
				),
			},
		}));
		useChatsStore.setState((state) => {
			return {
				selectedChatId: chat.id,
				selectedChatByProject: {
					...state.selectedChatByProject,
					[session.projectId]: chat.id,
				},
			};
		});
		void useChatsStore.getState().setActiveSession(chat.id, session.id);
	},
	setActiveSession: (chatId, sessionId) => {
		void useChatsStore.getState().setActiveSession(chatId, sessionId);
	},
});

/** Archive a chat while exposing progress to every archive entry point. */
export async function archiveChatWithConfirm(chatId: ChatId): Promise<void> {
	const { archive, setArchiveProgress, clearArchiveProgress } =
		useChatsStore.getState();

	setArchiveProgress(chatId, "archiving");
	try {
		const result = await archive(chatId);
		if (!result.ok) return;
	} finally {
		clearArchiveProgress(chatId);
	}
}

// Mirror `selectedChatId` from the active project's slot — same pattern
// as `useSessionsStore` so switching projects swaps the active chat too.
useWorkspaceStore.subscribe((ws, prev) => {
	if (ws.selectedFolderId === prev.selectedFolderId) return;
	const slot =
		ws.selectedFolderId !== null
			? (useChatsStore.getState().selectedChatByProject[ws.selectedFolderId] ??
				null)
			: null;
	if (useChatsStore.getState().selectedChatId !== slot) {
		useChatsStore.setState({ selectedChatId: slot });
	}
});
