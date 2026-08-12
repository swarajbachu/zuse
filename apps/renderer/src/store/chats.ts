import {
	Chat,
	type ChatArchiveJob,
	type ChatArchiveResult,
	type ChatCreationOperation,
	ChatId,
	type ChatSummaryChange,
	type ChatUnarchiveResult,
	type ChatWorkspacePolicy,
	ComposerInput,
	type FolderId,
	type Message,
	type PermissionMode,
	type ProviderId,
	type RuntimeMode,
	Session,
	SessionId,
	type WorktreeId,
} from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";
import { toastManager } from "../components/ui/toast.tsx";
import { formatError } from "../lib/format-error.ts";
import { upsertLatestEntity } from "../lib/latest-entity.ts";
import {
	markRendererInteraction,
	trackRendererRpc,
} from "../lib/performance-marks.ts";
import {
	getActiveEnvironment,
	getRpcClient,
	reportRendererRpcStreamFailure,
	subscribeRendererRpcConnection,
} from "../lib/rpc-client.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { batchAtomUpdates } from "../state/registry.tsx";
import { useArchivePreviewStore } from "./archive-preview.ts";
import { registerChatCommands } from "./chat-commands.ts";
import { cloudSummaryForChat } from "./cloud-chat-registry.ts";
import {
	acknowledgeTimelineSessionCreated,
	deferTimelineUntilSessionCreated,
	discardTimelineSessionCreation,
	useMessagesStore,
} from "./messages.ts";
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
			const client = await getRpcClient();
			const job = await Effect.runPromise(
				client["chat.archiveStatus"]({ chatId }),
			);
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
 * Sidebar-level chat catalog. A chat is the container that holds one or
 * more sessions ("tabs"). The sidebar renders chats; the tab strip in the
 * main pane renders the active chat's sessions. Chats own the worktree
 * binding — all sessions inside a chat share that worktree.
 *
 * `activeSessionId` (mirrored from the server's `chats.active_session_id`
 * column) is the last tab the user was on inside a chat. Clicking a chat in
 * the sidebar restores that tab — no in-memory memo required.
 */
type ChatsState = {
	readonly chatsByProject: Record<string, ReadonlyArray<Chat>>;
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
	readonly retryCreation: (
		chatId: ChatId,
		preserveFocus?: boolean,
	) => Promise<boolean>;
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
			readonly initialMessage: Message | null;
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
	readonly prompt: string | null;
	readonly workspaceRequested: boolean;
	readonly worktreeId: WorktreeId | null;
	readonly workspacePolicy: ChatWorkspacePolicy | null;
	readonly phase: "creating-workspace" | "creating-chat" | "failed";
	readonly error: string | null;
	readonly previousChatId: ChatId | null;
	readonly previousSessionId: SessionId | null;
	readonly startupQueueId: string | null;
	readonly startedAt: number;
};

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

const chatProjectIndex = new Map<ChatId, FolderId>();
const creationRetryPromises = new Map<string, Promise<boolean>>();

const findChatProject = (
	chatsByProject: ChatsState["chatsByProject"],
	chatId: ChatId,
): FolderId | null => {
	const indexed = chatProjectIndex.get(chatId);
	if (indexed !== undefined) return indexed;
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

/**
 * Snapshot-plus-live `chat.streamChanges` subscription per project — one
 * long-lived fiber keyed by projectId. Carries server-side chat rows (notably
 * orchestrated creates and background auto-name updates) so the sidebar stays
 * reconciled without a manual refetch.
 */
const changeFibers = new Map<string, Fiber.Fiber<unknown, unknown>>();
const creationFibers = new Map<string, Fiber.Fiber<unknown, unknown>>();
const changeGenerations = new Map<string, number>();
const changeConnectionSubscriptions = new Map<string, () => void>();
const changeLifecycles = new Map<string, number>();
const snapshotFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
const catalogSnapshotRevisions = new Map<string, number>();

const currentChangeLifecycle = (projectId: FolderId): number =>
	changeLifecycles.get(projectId) ?? 0;

const applyChatChange = (
	projectId: FolderId,
	lifecycle: number,
	change: ChatSummaryChange,
): void => {
	if (currentChangeLifecycle(projectId) !== lifecycle) return;
	if (change._tag === "snapshot") {
		catalogSnapshotRevisions.set(
			projectId,
			(catalogSnapshotRevisions.get(projectId) ?? 0) + 1,
		);
		const fallbackTimer = snapshotFallbackTimers.get(projectId);
		if (fallbackTimer !== undefined) {
			clearTimeout(fallbackTimer);
			snapshotFallbackTimers.delete(projectId);
		}
		useChatsStore.setState((state) => {
			const pendingChatIds = new Set(
				Object.values(state.pendingCreationByChat)
					.filter((creation) => creation.projectId === projectId)
					.map((creation) => creation.chatId),
			);
			let chats: ReadonlyArray<Chat> = change.chats;
			for (const chat of state.chatsByProject[projectId] ?? []) {
				if (pendingChatIds.has(chat.id)) chats = upsertChat(chats, chat);
			}
			return {
				chatsByProject: {
					...state.chatsByProject,
					[projectId]: chats,
				},
				loadingByProject: {
					...state.loadingByProject,
					[projectId]: false,
				},
				error: null,
			};
		});
		return;
	}
	const chat = change.chat;
	let inserted = false;
	useChatsStore.setState((s) => {
		if (currentChangeLifecycle(projectId) !== lifecycle) return s;
		const chats = s.chatsByProject[projectId];
		if (chats === undefined) return s;
		inserted = !chats.some((candidate) => candidate.id === chat.id);
		return {
			chatsByProject: {
				...s.chatsByProject,
				[projectId]: upsertChat(chats, chat),
			},
		};
	});
	const activeSessionId = chat.activeSessionId;
	const knownSessions =
		useSessionsStore.getState().sessionsByProject[projectId];
	const activeSessionMissing =
		activeSessionId !== null &&
		knownSessions !== undefined &&
		!knownSessions.some((session) => session.id === activeSessionId);
	if (inserted || activeSessionMissing) {
		void useSessionsStore.getState().hydrate(projectId);
	}
};

const scheduleSnapshotFallback = (
	projectId: FolderId,
	lifecycle: number,
): void => {
	const previous = snapshotFallbackTimers.get(projectId);
	if (previous !== undefined) clearTimeout(previous);
	const timer = setTimeout(() => {
		snapshotFallbackTimers.delete(projectId);
		if (currentChangeLifecycle(projectId) !== lifecycle) return;
		void (async () => {
			const snapshotRevision = catalogSnapshotRevisions.get(projectId) ?? 0;
			try {
				const client = await getRpcClient();
				const chats = await Effect.runPromise(
					client["chat.list"]({ projectId }),
				);
				if (
					currentChangeLifecycle(projectId) !== lifecycle ||
					(catalogSnapshotRevisions.get(projectId) ?? 0) !== snapshotRevision
				)
					return;
				applyChatChange(projectId, lifecycle, {
					_tag: "snapshot",
					chats,
				});
			} catch (error) {
				if (
					currentChangeLifecycle(projectId) !== lifecycle ||
					(catalogSnapshotRevisions.get(projectId) ?? 0) !== snapshotRevision
				)
					return;
				useChatsStore.setState((state) => ({
					loadingByProject: {
						...state.loadingByProject,
						[projectId]: false,
					},
					error: formatError(error),
				}));
			}
		})();
	}, 750);
	snapshotFallbackTimers.set(projectId, timer);
};

const runChatChangeStream = Effect.fn("ChatsStore.runChatChangeStream")(
	function* (
		projectId: FolderId,
		generation: number,
		lifecycle: number,
	): Effect.fn.Return<void> {
		const clientResult = yield* Effect.tryPromise(() => getRpcClient()).pipe(
			Effect.result,
		);
		if (
			changeGenerations.get(projectId) !== generation ||
			currentChangeLifecycle(projectId) !== lifecycle
		)
			return;
		if (clientResult._tag === "Failure") {
			reportRendererRpcStreamFailure(generation, clientResult.failure);
			useChatsStore.setState({ error: formatError(clientResult.failure) });
			return;
		}
		const streamResult = yield* Stream.runForEach(
			clientResult.success["chat.streamChanges"]({ projectId }),
			(chat) => Effect.sync(() => applyChatChange(projectId, lifecycle, chat)),
		).pipe(Effect.result);
		if (
			changeGenerations.get(projectId) !== generation ||
			currentChangeLifecycle(projectId) !== lifecycle
		)
			return;
		reportRendererRpcStreamFailure(
			generation,
			streamResult._tag === "Failure"
				? streamResult.failure
				: new Error("chat change stream completed unexpectedly"),
		);
	},
);

const applyCreationChange = (
	projectId: FolderId,
	lifecycle: number,
	operation: ChatCreationOperation,
): void => {
	if (currentChangeLifecycle(projectId) !== lifecycle) return;
	const current =
		useChatsStore.getState().pendingCreationByChat[operation.chatId];
	if (current === undefined) return;
	if (operation.status === "succeeded") {
		acknowledgeTimelineSessionCreated(operation.initialSessionId);
		useChatsStore.setState((state) => ({
			pendingCreationByChat: Object.fromEntries(
				Object.entries(state.pendingCreationByChat).filter(
					([chatId]) => chatId !== operation.chatId,
				),
			),
			creatingByProject: {
				...state.creatingByProject,
				[projectId]: false,
			},
		}));
		void useSessionsStore.getState().hydrate(projectId);
		return;
	}

	const phase =
		operation.status === "failed"
			? "failed"
			: operation.status === "creating_chat"
				? "creating-chat"
				: "creating-workspace";
	useChatsStore.setState((state) => {
		if (currentChangeLifecycle(projectId) !== lifecycle) return state;
		const pending = state.pendingCreationByChat[operation.chatId];
		if (pending === undefined) return state;
		return {
			pendingCreationByChat: {
				...state.pendingCreationByChat,
				[operation.chatId]: {
					...pending,
					worktreeId: operation.worktreeId,
					phase,
					error: operation.error,
				},
			},
			creatingByProject:
				phase === "failed"
					? { ...state.creatingByProject, [projectId]: false }
					: state.creatingByProject,
			chatsByProject: {
				...state.chatsByProject,
				[projectId]: (state.chatsByProject[projectId] ?? []).map((chat) =>
					chat.id === operation.chatId
						? Chat.make({ ...chat, worktreeId: operation.worktreeId })
						: chat,
				),
			},
		};
	});
	useSessionsStore.setState((state) => ({
		sessionsByProject: {
			...state.sessionsByProject,
			[projectId]: (state.sessionsByProject[projectId] ?? []).map((session) =>
				session.id === operation.initialSessionId
					? Session.make({
							...session,
							worktreeId: operation.worktreeId,
							status: phase === "failed" ? "error" : session.status,
						})
					: session,
			),
		},
	}));
	if (operation.worktreeId !== null) {
		void useWorktreesStore.getState().refresh(projectId);
	}
};

const runCreationChangeStream = Effect.fn("ChatsStore.runCreationChangeStream")(
	function* (
		projectId: FolderId,
		generation: number,
		lifecycle: number,
	): Effect.fn.Return<void> {
		const clientResult = yield* Effect.tryPromise(() => getRpcClient()).pipe(
			Effect.result,
		);
		if (
			changeGenerations.get(projectId) !== generation ||
			currentChangeLifecycle(projectId) !== lifecycle
		)
			return;
		if (clientResult._tag === "Failure") {
			reportRendererRpcStreamFailure(generation, clientResult.failure);
			return;
		}
		const creationStream = (
			clientResult.success as typeof clientResult.success & {
				readonly "chat.creation.stream"?: (typeof clientResult.success)["chat.creation.stream"];
			}
		)["chat.creation.stream"];
		if (creationStream === undefined) return;
		const streamResult = yield* Stream.runForEach(
			creationStream({ projectId }),
			(operation) =>
				Effect.sync(() => applyCreationChange(projectId, lifecycle, operation)),
		).pipe(Effect.result);
		if (
			changeGenerations.get(projectId) !== generation ||
			currentChangeLifecycle(projectId) !== lifecycle
		)
			return;
		reportRendererRpcStreamFailure(
			generation,
			streamResult._tag === "Failure"
				? streamResult.failure
				: new Error("chat creation stream completed unexpectedly"),
		);
	},
);

const ensureChangeStream = (projectId: FolderId, lifecycle: number): void => {
	if (currentChangeLifecycle(projectId) !== lifecycle) return;
	if (changeConnectionSubscriptions.has(projectId)) return;
	const unsubscribe = subscribeRendererRpcConnection((snapshot) => {
		if (currentChangeLifecycle(projectId) !== lifecycle) return;
		if (snapshot.status !== "connected") return;
		if (changeGenerations.get(projectId) === snapshot.generation) return;
		changeGenerations.set(projectId, snapshot.generation);
		const previous = changeFibers.get(projectId);
		if (previous !== undefined) {
			void Effect.runPromise(Fiber.interrupt(previous)).catch(() => {});
		}
		const previousCreation = creationFibers.get(projectId);
		if (previousCreation !== undefined) {
			void Effect.runPromise(Fiber.interrupt(previousCreation)).catch(() => {});
		}
		changeFibers.set(
			projectId,
			Effect.runFork(
				runChatChangeStream(projectId, snapshot.generation, lifecycle),
			),
		);
		creationFibers.set(
			projectId,
			Effect.runFork(
				runCreationChangeStream(projectId, snapshot.generation, lifecycle),
			),
		);
	});
	changeConnectionSubscriptions.set(projectId, unsubscribe);
};

export const stopChatChangeStream = async (
	projectId: FolderId,
): Promise<void> => {
	changeLifecycles.set(projectId, currentChangeLifecycle(projectId) + 1);
	changeConnectionSubscriptions.get(projectId)?.();
	changeConnectionSubscriptions.delete(projectId);
	changeGenerations.delete(projectId);
	const fallbackTimer = snapshotFallbackTimers.get(projectId);
	if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
	snapshotFallbackTimers.delete(projectId);
	catalogSnapshotRevisions.delete(projectId);
	const fiber = changeFibers.get(projectId);
	changeFibers.delete(projectId);
	if (fiber !== undefined) {
		await Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {});
	}
	const creationFiber = creationFibers.get(projectId);
	creationFibers.delete(projectId);
	if (creationFiber !== undefined) {
		await Effect.runPromise(Fiber.interrupt(creationFiber)).catch(() => {});
	}
	useChatsStore.setState((state) => {
		const chatsByProject = { ...state.chatsByProject };
		const loadingByProject = { ...state.loadingByProject };
		const selectedChatByProject = { ...state.selectedChatByProject };
		const removedChats = chatsByProject[projectId] ?? [];
		delete chatsByProject[projectId];
		delete loadingByProject[projectId];
		delete selectedChatByProject[projectId];
		const selectedChatId = removedChats.some(
			(chat) => chat.id === state.selectedChatId,
		)
			? null
			: state.selectedChatId;
		return {
			chatsByProject,
			loadingByProject,
			selectedChatByProject,
			selectedChatId,
		};
	});
};

const restorePendingCreation = (
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
			status: operation.status === "failed" ? "error" : "idle",
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
			prompt: operation.prompt,
			workspaceRequested: operation.workspacePolicy._tag !== "main",
			worktreeId: operation.worktreeId,
			workspacePolicy: operation.workspacePolicy,
			phase:
				operation.status === "failed"
					? "failed"
					: operation.status === "creating_workspace" ||
							operation.status === "pending"
						? "creating-workspace"
						: "creating-chat",
			error: operation.error,
			previousChatId: null,
			previousSessionId: null,
			startupQueueId: operation.startupQueueId,
			startedAt: performance.now(),
		},
	};
};

export const useChatsStore = create<ChatsState>((set, get) => ({
	chatsByProject: {},
	selectedChatId: null,
	selectedChatByProject: {},
	loadingByProject: {},
	creatingByProject: {},
	pendingCreationByChat: {},
	archiveProgressByChat: {},
	error: null,
	hydrate: async (projectId) => {
		const lifecycle = currentChangeLifecycle(projectId);
		set((s) => ({
			chatsByProject:
				s.chatsByProject[projectId] === undefined
					? { ...s.chatsByProject, [projectId]: [] }
					: s.chatsByProject,
			loadingByProject: { ...s.loadingByProject, [projectId]: true },
			error: null,
		}));
		ensureChangeStream(projectId, lifecycle);
		scheduleSnapshotFallback(projectId, lifecycle);
		try {
			const client = await getRpcClient();
			const archiveJobsRpc = (
				client as typeof client & {
					readonly "chat.archiveJobs"?: (typeof client)["chat.archiveJobs"];
				}
			)["chat.archiveJobs"];
			const creationListRpc = (
				client as typeof client & {
					readonly "chat.creation.list"?: (typeof client)["chat.creation.list"];
				}
			)["chat.creation.list"];
			const [archiveJobs, creationOperations] = await Promise.all([
				archiveJobsRpc === undefined
					? Promise.resolve([])
					: Effect.runPromise(archiveJobsRpc({ projectId })),
				creationListRpc === undefined
					? Promise.resolve([])
					: Effect.runPromise(creationListRpc({ projectId })),
			]);
			for (const job of archiveJobs) {
				if (job.status === "failed") notifyArchiveFailure(job);
				else monitorArchiveJob(job.chatId);
			}
			if (currentChangeLifecycle(projectId) !== lifecycle) return;
			const chats = get().chatsByProject[projectId] ?? [];
			const restored = creationOperations
				.filter((operation) => operation.status !== "succeeded")
				.map(restorePendingCreation);
			const durableChatIds = new Set(chats.map((chat) => chat.id));
			const succeededOperationIds = new Set(
				creationOperations
					.filter((operation) => operation.status === "succeeded")
					.map((operation) => operation.operationId),
			);
			set((s) => ({
				chatsByProject: {
					...s.chatsByProject,
					[projectId]: restored.reduce(
						(list, pending) => upsertChat(list, pending.chat),
						chats,
					),
				},
				pendingCreationByChat: {
					...Object.fromEntries(
						Object.entries(s.pendingCreationByChat).filter(
							([, creation]) =>
								creation.projectId !== projectId ||
								(!durableChatIds.has(creation.chatId) &&
									!succeededOperationIds.has(creation.operationId)),
						),
					),
					...Object.fromEntries(
						restored.map((pending) => [pending.chat.id, pending.creation]),
					),
				},
			}));
			useSessionsStore.setState((s) => ({
				sessionsByProject: {
					...s.sessionsByProject,
					[projectId]: restored.reduce(
						(list, pending) => upsertLatestEntity(list, pending.session),
						s.sessionsByProject[projectId] ?? [],
					),
				},
			}));
			for (const pending of restored) {
				if (pending.creation.phase !== "failed") {
					void get().retryCreation(pending.chat.id, true);
				}
			}
		} catch (err) {
			if (currentChangeLifecycle(projectId) !== lifecycle) return;
			set({ error: formatError(err) });
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
				const client = await getRpcClient(targetEnvironmentId);
				const result = await trackRendererRpc("chat.create", () =>
					Effect.runPromise(
						client["chat.create"]({
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
						}),
					),
				);
				const { chat, initialSession, initialMessage } = result;
				return {
					chatId: chat.id,
					initialSessionId: initialSession.id,
					worktreeId: chat.worktreeId,
					startupQueueId: null,
					remoteSeed: { chat, initialSession, initialMessage },
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
		deferTimelineUntilSessionCreated(initialSessionId);
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
			prompt: opts?.startupInput?.text.trim() || null,
			workspaceRequested: opts?.workspaceRequested === true,
			worktreeId: optimisticWorktreeId,
			workspacePolicy:
				opts?.workspacePolicy instanceof Promise
					? null
					: (opts?.workspacePolicy ?? null),
			phase:
				opts?.worktreeId instanceof Promise ||
				opts?.workspacePolicy instanceof Promise
					? "creating-workspace"
					: "creating-chat",
			error: null,
			previousChatId,
			previousSessionId,
			startupQueueId: opts?.startupQueueId ?? null,
			startedAt: performance.now(),
		};
		const pendingCreation: PendingChatCreation =
			previousPending === undefined
				? nextPending
				: {
						...previousPending,
						workspacePolicy: nextPending.workspacePolicy,
						phase: nextPending.phase,
						error: null,
						startedAt: nextPending.startedAt,
					};
		let startupQueueId =
			opts?.startupQueueId ?? previousPending?.startupQueueId ?? null;
		batchAtomUpdates(() => {
			set((s) => ({
				error: null,
				creatingByProject: { ...s.creatingByProject, [projectId]: true },
				pendingCreationByChat: {
					...s.pendingCreationByChat,
					[chatId]: pendingCreation,
				},
				chatsByProject: {
					...s.chatsByProject,
					[projectId]: upsertChat(
						s.chatsByProject[projectId] ?? [],
						optimisticChat,
					),
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
				sessionsByProject: {
					...s.sessionsByProject,
					[projectId]: upsertLatestEntity(
						s.sessionsByProject[projectId] ?? [],
						optimisticSession,
					),
				},
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
			if (opts?.startupInput !== undefined && opts.reusePending !== true) {
				startupQueueId = useMessagesStore
					.getState()
					.queue(initialSessionId, opts.startupInput, { persist: false });
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
		try {
			const workspacePolicy = await opts?.workspacePolicy;
			const worktreeId = await (opts?.worktreeId ?? null);
			const knownWorktreeId =
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
						phase:
							workspacePolicy?._tag === "fresh"
								? "creating-workspace"
								: "creating-chat",
					},
				},
				chatsByProject: {
					...s.chatsByProject,
					[projectId]: (s.chatsByProject[projectId] ?? []).map((row) =>
						row.id === chatId
							? Chat.make({ ...row, worktreeId: knownWorktreeId })
							: row,
					),
				},
			}));
			useSessionsStore.setState((s) => ({
				sessionsByProject: {
					...s.sessionsByProject,
					[projectId]: (s.sessionsByProject[projectId] ?? []).map((row) =>
						row.id === initialSessionId
							? Session.make({ ...row, worktreeId: knownWorktreeId })
							: row,
					),
				},
			}));
			const client = await getRpcClient();
			const result = await trackRendererRpc("chat.create", () =>
				Effect.runPromise(
					client["chat.create"]({
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
						permissionMode: opts?.permissionMode,
						toolSearch: opts?.toolSearch,
						background: true,
					}),
				),
			);
			markRendererInteraction(initialSessionId, "entity-acknowledged");
			const { chat, initialSession, initialMessage } = result;
			// Seed the messages store FIRST so the chat view, when it mounts on
			// the next render, finds the initial user message already in place —
			// no empty-state flash, no waiting on the live stream to backfill.
			// `useMessagesStore.hydrate` will dedupe against this id when the
			// backfill arrives, so there's no double-render.
			if (initialMessage !== null) {
				useMessagesStore.setState((s) => ({
					messagesBySession: {
						...s.messagesBySession,
						[initialSession.id]: [initialMessage],
					},
				}));
			}
			// Land the new chat in front of the project's existing list and
			// mark it active so the renderer immediately swaps to it.
			set((s) => {
				const existing = s.chatsByProject[projectId] ?? [];
				const stillOwnsSelection =
					s.selectedChatId === chatId &&
					s.selectedChatByProject[projectId] === chatId;
				return {
					chatsByProject: {
						...s.chatsByProject,
						[projectId]: upsertChat(existing, chat),
					},
					selectedChatId: stillOwnsSelection ? chat.id : s.selectedChatId,
					selectedChatByProject: stillOwnsSelection
						? { ...s.selectedChatByProject, [projectId]: chat.id }
						: s.selectedChatByProject,
					creatingByProject: {
						...s.creatingByProject,
						[projectId]: false,
					},
					pendingCreationByChat: Object.fromEntries(
						Object.entries(s.pendingCreationByChat).filter(
							([id]) => id !== chatId,
						),
					),
				};
			});
			// Mirror the initial session into the sessions store and select it
			// so the chat surface (composer, message list, cost footer) wires up
			// on the very next render.
			useSessionsStore.setState((s) => {
				const list = s.sessionsByProject[projectId] ?? [];
				const stillOwnsSelection =
					s.selectedSessionId === initialSessionId &&
					s.selectedSessionByProject[projectId] === initialSessionId;
				// The live chat stream can hydrate this row before create() resolves.
				// Deduplicate the row without dropping the selection transition.
				return {
					sessionsByProject: {
						...s.sessionsByProject,
						[projectId]: upsertLatestEntity(list, initialSession),
					},
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
			acknowledgeTimelineSessionCreated(initialSession.id);
			if (chat.worktreeId !== null) {
				void useWorktreesStore.getState().refresh(projectId);
			}
			return {
				chatId: chat.id,
				initialSessionId: initialSession.id,
				worktreeId: chat.worktreeId,
				startupQueueId,
			};
		} catch (err) {
			const reason = formatError(err);
			batchAtomUpdates(() => {
				useSessionsStore.setState((s) => ({
					sessionsByProject: {
						...s.sessionsByProject,
						[projectId]: (s.sessionsByProject[projectId] ?? []).map((row) =>
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
					workspaceRequested: creation.workspaceRequested,
					workspacePolicy:
						creation.workspacePolicy ??
						(creation.workspaceRequested
							? { _tag: "fresh" }
							: { _tag: "main" }),
				},
			);
			if (result !== null && creation.startupInput !== undefined) {
				const queueId =
					creation.startupQueueId ??
					useMessagesStore
						.getState()
						.queue(result.initialSessionId, creation.startupInput, {
							persist: false,
						});
				await useMessagesStore
					.getState()
					.persistQueued(
						result.initialSessionId,
						queueId,
						creation.startupInput,
						{ ready: true },
					);
			}
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
	discardCreation: (chatId) => {
		const creation = get().pendingCreationByChat[chatId];
		if (creation === undefined) return;
		void (async () => {
			try {
				const client = await getRpcClient();
				await Effect.runPromise(
					client["chat.creation.discard"]({
						operationId: creation.operationId,
					}),
				);
			} catch {
				// Local discard remains responsive; a reconnect list can reconcile
				// the durable operation if the server did not receive this request.
			}
		})();
		discardTimelineSessionCreation(creation.sessionId);
		if (creation.startupQueueId !== null) {
			useMessagesStore
				.getState()
				.dropFromQueue(creation.sessionId, creation.startupQueueId);
		}
		useSessionsStore.setState((s) => ({
			sessionsByProject: {
				...s.sessionsByProject,
				[creation.projectId]: (
					s.sessionsByProject[creation.projectId] ?? []
				).filter((session) => session.id !== creation.sessionId),
			},
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
			chatsByProject: {
				...s.chatsByProject,
				[creation.projectId]: (
					s.chatsByProject[creation.projectId] ?? []
				).filter((chat) => chat.id !== creation.chatId),
			},
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
		useTerminalsStore.getState().disposeChat(chatId);
		useUiStore.getState().clearChatPanels(chatId);
	},
	rename: async (chatId, title) => {
		set({ error: null });
		try {
			const cloud = cloudSummaryForChat(chatId);
			if (cloud !== null) {
				const [{ getControlPlaneRpcClient }, cloudChats] = await Promise.all([
					import("../lib/rpc-client.ts"),
					import("./cloud-chats.ts"),
				]);
				const control = await getControlPlaneRpcClient();
				const renamed = await Effect.runPromise(
					control["cloud.chats.rename"]({
						workspaceId: cloud.workspaceId,
						title,
					}),
				);
				cloudChats.stageCloudChat(
					renamed,
					cloudChats.localProjectForCloudChat(chatId) ??
						(() => {
							throw new Error("Cloud chat project is not available.");
						})(),
				);
				return;
			}
			const client = await getRpcClient();
			const renamed = await Effect.runPromise(
				client["chat.rename"]({ chatId, title }),
			);
			set((s) => {
				const projectId = findChatProject(s.chatsByProject, chatId);
				if (projectId === null) return {};
				const chats = s.chatsByProject[projectId] ?? [];
				return {
					chatsByProject: {
						...s.chatsByProject,
						[projectId]: chats.map((c) => (c.id === chatId ? renamed : c)),
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
			const client = await getRpcClient();
			const chat = await Effect.runPromise(
				client["chat.setWorktree"]({ chatId, worktreeId }),
			);
			set((s) => {
				const projectId = findChatProject(s.chatsByProject, chatId);
				if (projectId === null) return {};
				const chats = s.chatsByProject[projectId] ?? [];
				return {
					chatsByProject: {
						...s.chatsByProject,
						[projectId]: chats.map((c) => (c.id === chatId ? chat : c)),
					},
				};
			});
			// Mirror the worktree change onto every member session in the
			// renderer cache; the server has already updated the DB rows.
			useSessionsStore.setState((s) => {
				const projectId = findChatProject(get().chatsByProject, chatId);
				if (projectId === null) return s;
				const list = s.sessionsByProject[projectId] ?? [];
				return {
					sessionsByProject: {
						...s.sessionsByProject,
						[projectId]: list.map(
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
		set((s) => {
			const projectId = findChatProject(s.chatsByProject, chatId);
			if (projectId === null) return s;
			const chats = s.chatsByProject[projectId] ?? [];
			return {
				chatsByProject: {
					...s.chatsByProject,
					[projectId]: chats.map((c) =>
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
			const client = await getRpcClient();
			await Effect.runPromise(
				client["chat.setActiveSession"]({ chatId, sessionId }),
			);
		} catch (err) {
			set({ error: formatError(err) });
		}
	},
	archive: async (chatId, force = false) => {
		set({ error: null });
		const provisional = get().pendingCreationByChat[chatId];
		if (provisional?.phase === "failed") {
			get().discardCreation(chatId);
			return { ok: true } as const;
		}
		const projectIdBeforeArchive = findChatProject(
			get().chatsByProject,
			chatId,
		);
		const selectedAtStart = get().selectedChatId === chatId;
		const liveChatsBefore =
			projectIdBeforeArchive === null
				? []
				: (get().chatsByProject[projectIdBeforeArchive] ?? []).filter(
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
				: (get().chatsByProject[projectIdBeforeArchive] ?? []);
		const sessionsState = useSessionsStore.getState();
		const sessionsSnapshot =
			projectIdBeforeArchive === null
				? null
				: (sessionsState.sessionsByProject[projectIdBeforeArchive] ?? []);
		const selectedSessionSnapshot = sessionsState.selectedSessionId;
		const failedChatSnapshot = chatsSnapshot?.find(
			(candidate) => candidate.id === chatId,
		);
		const failedSessionSnapshots =
			sessionsSnapshot?.filter((candidate) => candidate.chatId === chatId) ??
			[];
		if (projectIdBeforeArchive !== null) {
			set((s) => ({
				chatsByProject: {
					...s.chatsByProject,
					[projectIdBeforeArchive]: (
						s.chatsByProject[projectIdBeforeArchive] ?? []
					).filter((chat) => chat.id !== chatId),
				},
			}));
			useSessionsStore.setState((s) => ({
				sessionsByProject: {
					...s.sessionsByProject,
					[projectIdBeforeArchive]: (
						s.sessionsByProject[projectIdBeforeArchive] ?? []
					).filter((row) => row.chatId !== chatId),
				},
			}));
			if (selectedAtStart) get().select(fallbackChatId);
		}
		let result: ChatArchiveResult;
		try {
			const client = await getRpcClient();
			result = await Effect.runPromise(
				client["chat.archive"]({ chatId, ...(force ? { force: true } : {}) }),
			);
		} catch (err) {
			const reason = formatError(err);
			let reconciled: ChatArchiveResult | null = null;
			let definitiveFailure = false;
			try {
				const client = await getRpcClient();
				const [chat, job] = await Promise.all([
					Effect.runPromise(client["chat.get"]({ chatId })),
					Effect.runPromise(client["chat.archiveStatus"]({ chatId })),
				]);
				if (chat.archivedAt !== null) {
					reconciled = { chat, cleanup: null, checkpoint: null, job };
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
				const shouldRestoreSelection =
					selectedAtStart && get().selectedChatId === fallbackChatId;
				if (
					projectIdBeforeArchive !== null &&
					failedChatSnapshot !== undefined
				) {
					set((s) => ({
						error: reason,
						chatsByProject: {
							...s.chatsByProject,
							[projectIdBeforeArchive]: upsertChat(
								s.chatsByProject[projectIdBeforeArchive] ?? [],
								failedChatSnapshot,
							),
						},
					}));
					if (failedSessionSnapshots.length > 0) {
						useSessionsStore.setState((s) => ({
							sessionsByProject: {
								...s.sessionsByProject,
								[projectIdBeforeArchive]: [
									...failedSessionSnapshots,
									...(s.sessionsByProject[projectIdBeforeArchive] ?? []).filter(
										(candidate) => candidate.chatId !== chatId,
									),
								],
							},
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
		set((s) => {
			const chats = s.chatsByProject[projectId] ?? [];
			return {
				chatsByProject: {
					...s.chatsByProject,
					[projectId]: chats.filter((chat) => chat.id !== chatId),
				},
			};
		});
		useSessionsStore.setState((s) => {
			const list = s.sessionsByProject[projectId] ?? [];
			return {
				sessionsByProject: {
					...s.sessionsByProject,
					[projectId]: list.filter((row) => row.chatId !== chatId),
				},
				selectedSessionId:
					s.selectedSessionId !== null &&
					list.find((row) => row.id === s.selectedSessionId)?.chatId === chatId
						? null
						: s.selectedSessionId,
			};
		});
		if (selectedAtStart && get().selectedChatId === chatId) {
			get().select(fallbackChatId);
		}
		useTerminalsStore.getState().disposeChat(chatId);
		useUiStore.getState().clearChatPanels(chatId);
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
					const [{ getControlPlaneRpcClient }, cloudChats] = await Promise.all([
						import("../lib/rpc-client.ts"),
						import("./cloud-chats.ts"),
					]);
					const control = await getControlPlaneRpcClient();
					const workspace = await Effect.runPromise(
						control["cloud.workspaces.unarchive"]({
							workspaceId: cloud.workspaceId,
						}),
					);
					const projectId = cloudChats.localProjectForCloudChat(chatId);
					if (projectId === null)
						throw new Error("Cloud chat project is not available.");
					const restoredSummary = {
						...cloud,
						state: workspace.state,
						desiredState: workspace.desiredState,
						runtimeState: workspace.runtimeState,
						statusCode: workspace.statusCode,
						startupPhase: workspace.startupPhase,
						revision: workspace.revision,
						updatedAt: workspace.updatedAt,
						archivedAt: undefined,
					};
					cloudChats.stageCloudChat(restoredSummary, projectId);
					archives.removeChat(chatId, projectId);
					get().select(chatId);
					const chat = get().chatsByProject[projectId]?.find(
						(candidate) => candidate.id === chatId,
					);
					const sessions = useSessionsStore
						.getState()
						.sessionsByProject[projectId]?.filter(
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
				const client = await getRpcClient();
				const result = await Effect.runPromise(
					client["chat.unarchive"]({ chatId }),
				);
				const projectId = findChatProject(get().chatsByProject, chatId);
				const resolvedProjectId = projectId ?? result.chat.projectId;
				set((s) => {
					const chats = s.chatsByProject[resolvedProjectId] ?? [];
					const nextChats = chats.some((chat) => chat.id === chatId)
						? chats.map((chat) => (chat.id === chatId ? result.chat : chat))
						: [result.chat, ...chats];
					return {
						chatsByProject: {
							...s.chatsByProject,
							[resolvedProjectId]: nextChats,
						},
						selectedChatId: result.chat.id,
						selectedChatByProject: {
							...s.selectedChatByProject,
							[resolvedProjectId]: result.chat.id,
						},
					};
				});
				useSessionsStore.setState((s) => {
					const existing = s.sessionsByProject[resolvedProjectId] ?? [];
					const restoredIds = new Set(result.sessions.map((row) => row.id));
					const landingId =
						result.chat.activeSessionId !== null &&
						restoredIds.has(result.chat.activeSessionId)
							? result.chat.activeSessionId
							: (result.sessions[0]?.id ?? null);
					return {
						sessionsByProject: {
							...s.sessionsByProject,
							[resolvedProjectId]: [
								...result.sessions,
								...existing.filter((row) => !restoredIds.has(row.id)),
							],
						},
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
		set({ error: null });
		if (get().pendingCreationByChat[chatId]?.phase === "failed") {
			get().discardCreation(chatId);
			return;
		}
		try {
			const client = await getRpcClient();
			await Effect.runPromise(client["chat.delete"]({ chatId }));
			const projectId = findChatProject(get().chatsByProject, chatId);
			set((s) => {
				if (projectId === null) return {};
				const chats = s.chatsByProject[projectId] ?? [];
				const perProject =
					s.selectedChatByProject[projectId] === chatId
						? { ...s.selectedChatByProject, [projectId]: null }
						: s.selectedChatByProject;
				return {
					chatsByProject: {
						...s.chatsByProject,
						[projectId]: chats.filter((c) => c.id !== chatId),
					},
					selectedChatId: s.selectedChatId === chatId ? null : s.selectedChatId,
					selectedChatByProject: perProject,
				};
			});
			// Drop the chat's sessions from the renderer cache. The server has
			// cascaded the rows; this just keeps the UI in lockstep without a
			// re-hydrate round-trip.
			useSessionsStore.setState((s) => {
				if (projectId === null) return s;
				const list = s.sessionsByProject[projectId] ?? [];
				return {
					sessionsByProject: {
						...s.sessionsByProject,
						[projectId]: list.filter((row) => row.chatId !== chatId),
					},
					selectedSessionId:
						s.selectedSessionId !== null &&
						list.find((row) => row.id === s.selectedSessionId)?.chatId ===
							chatId
							? null
							: s.selectedSessionId,
				};
			});
			// Dispose the deleted chat's terminals (closing their PTYs) and drop its
			// dock layout so nothing lingers after the chat is gone.
			useTerminalsStore.getState().disposeChat(chatId);
			useUiStore.getState().clearChatPanels(chatId);
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
		const projectId = findChatProject(get().chatsByProject, chatId);
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
		// Land on the chat's last-active tab. If the memo points at an
		// archived/deleted session, fall back to the oldest non-archived
		// session inside the chat (or null).
		const chat = get().chatsByProject[projectId ?? ""]?.find(
			(c) => c.id === chatId,
		);
		if (chat === undefined) return;
		const projectSessions =
			projectId === null
				? []
				: (useSessionsStore.getState().sessionsByProject[projectId] ?? []);
		const liveTabs = projectSessions.filter(
			(row) => row.chatId === chatId && row.archivedAt === null,
		);
		const memoSession =
			chat.activeSessionId !== null
				? liveTabs.find((row) => row.id === chat.activeSessionId)
				: undefined;
		const fallback = liveTabs[0] ?? null;
		const landingId = memoSession?.id ?? fallback?.id ?? null;
		useSessionsStore.getState().select(landingId);
		// Viewing a chat marks it read. `markRead` no-ops for archived chats.
		void get().markRead(chatId);
	},
	markRead: async (chatId) => {
		if (cloudSummaryForChat(chatId) !== null) return;
		const projectId = findChatProject(get().chatsByProject, chatId);
		if (projectId === null) return;
		const chat = (get().chatsByProject[projectId] ?? []).find(
			(c) => c.id === chatId,
		);
		if (chat === undefined || chat.archivedAt !== null) return;
		// Already read and no fresh activity — skip the round-trip.
		if (!isChatUnread(chat, null)) return;
		const now = new Date();
		const patch = (target: Chat, lastReadAt: Date): Chat =>
			Object.assign(Object.create(Object.getPrototypeOf(target)), target, {
				lastReadAt,
			});
		set((s) => {
			const chats = s.chatsByProject[projectId] ?? [];
			return {
				chatsByProject: {
					...s.chatsByProject,
					[projectId]: chats.map((c) => (c.id === chatId ? patch(c, now) : c)),
				},
			};
		});
		try {
			const client = await getRpcClient();
			const updated = await Effect.runPromise(
				client["chat.markRead"]({ chatId }),
			);
			set((s) => {
				const chats = s.chatsByProject[projectId] ?? [];
				return {
					chatsByProject: {
						...s.chatsByProject,
						[projectId]: chats.map((c) => (c.id === chatId ? updated : c)),
					},
				};
			});
		} catch (err) {
			// Non-fatal — the optimistic stamp already cleared the unread style.
			set({ error: formatError(err) });
		}
	},
	noteChatActivity: (chatId) =>
		set((s) => {
			const projectId = findChatProject(s.chatsByProject, chatId);
			if (projectId === null) return s;
			const chats = s.chatsByProject[projectId] ?? [];
			const now = new Date();
			return {
				chatsByProject: {
					...s.chatsByProject,
					[projectId]: chats.map((c) =>
						c.id === chatId
							? Object.assign(Object.create(Object.getPrototypeOf(c)), c, {
									lastMessageAt: now,
								})
							: c,
					),
				},
			};
		}),
}));

useChatsStore.subscribe((state, previous) => {
	if (state.chatsByProject === previous.chatsByProject) return;
	const projectIds = new Set([
		...Object.keys(previous.chatsByProject),
		...Object.keys(state.chatsByProject),
	]);
	for (const projectId of projectIds) {
		const before = previous.chatsByProject[projectId];
		const after = state.chatsByProject[projectId];
		if (before === after) continue;
		for (const chat of before ?? []) {
			if (chatProjectIndex.get(chat.id) === projectId) {
				chatProjectIndex.delete(chat.id);
			}
		}
		for (const chat of after ?? []) {
			chatProjectIndex.set(chat.id, projectId as FolderId);
		}
	}
});

registerChatCommands({
	upsertFork: (chat, session) => {
		useChatsStore.setState((state) => {
			const list = state.chatsByProject[session.projectId] ?? [];
			const next = list.some((row) => row.id === chat.id)
				? list.map((row) => (row.id === chat.id ? chat : row))
				: [chat, ...list];
			return {
				chatsByProject: {
					...state.chatsByProject,
					[session.projectId]: next,
				},
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
	stopProjectStream: stopChatChangeStream,
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
