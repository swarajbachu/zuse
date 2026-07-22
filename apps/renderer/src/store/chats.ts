import {
	Chat,
	type ChatArchiveJob,
	type ChatArchiveResult,
	ChatId,
	type ChatUnarchiveResult,
	type ComposerInput,
	type FolderId,
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
import {
	markRendererInteraction,
	trackRendererRpc,
} from "../lib/performance-marks.ts";
import {
	getRpcClient,
	reportRendererRpcStreamFailure,
	subscribeRendererRpcConnection,
} from "../lib/rpc-client.ts";
import { createAtomStore as create } from "../state/atom-store.ts";
import { batchAtomUpdates } from "../state/registry.tsx";
import { useArchivePreviewStore } from "./archive-preview.ts";
import { registerChatCommands } from "./chat-commands.ts";
import { useMessagesStore } from "./messages.ts";
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
	readonly archiveProgressByChat: Record<string, ChatArchiveProgressPhase>;
	readonly error: string | null;
	readonly hydrate: (projectId: FolderId) => Promise<void>;
	readonly create: (
		projectId: FolderId,
		providerId: ProviderId,
		model: string,
		opts?: {
			readonly title?: string;
			readonly runtimeMode?: RuntimeMode;
			readonly worktreeId?: WorktreeId | null | Promise<WorktreeId | null>;
			readonly permissionMode?: PermissionMode;
			readonly toolSearch?: boolean;
			readonly startupInput?: ComposerInput;
		},
	) => Promise<{
		readonly chatId: ChatId;
		readonly initialSessionId: SessionId;
		readonly startupQueueId: string | null;
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
	[chat, ...chats.filter((row) => row.id !== chat.id)].sort(
		(a, b) => chatSortTime(b) - chatSortTime(a),
	);

/**
 * Snapshot-plus-live `chat.streamChanges` subscription per project — one
 * long-lived fiber keyed by projectId. Carries server-side chat rows (notably
 * orchestrated creates and background auto-name updates) so the sidebar stays
 * reconciled without a manual refetch.
 */
const changeFibers = new Map<string, Fiber.Fiber<unknown, unknown>>();
const changeGenerations = new Map<string, number>();
const changeConnectionSubscriptions = new Map<string, () => void>();
const changeLifecycles = new Map<string, number>();

const currentChangeLifecycle = (projectId: FolderId): number =>
	changeLifecycles.get(projectId) ?? 0;

const applyChatChange = (
	projectId: FolderId,
	lifecycle: number,
	chat: Chat,
): void => {
	if (currentChangeLifecycle(projectId) !== lifecycle) return;
	let inserted = false;
	useChatsStore.setState((s) => {
		if (currentChangeLifecycle(projectId) !== lifecycle) return s;
		const chats = s.chatsByProject[projectId];
		if (chats === undefined) return s;
		inserted = !chats.some((c) => c.id === chat.id);
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
		!knownSessions.some((row) => row.id === activeSessionId);
	if (inserted || activeSessionMissing) {
		void useSessionsStore.getState().hydrate(projectId);
	}
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
		changeFibers.set(
			projectId,
			Effect.runFork(
				runChatChangeStream(projectId, snapshot.generation, lifecycle),
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
	const fiber = changeFibers.get(projectId);
	changeFibers.delete(projectId);
	if (fiber !== undefined) {
		await Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {});
	}
};

export const useChatsStore = create<ChatsState>((set, get) => ({
	chatsByProject: {},
	selectedChatId: null,
	selectedChatByProject: {},
	loadingByProject: {},
	creatingByProject: {},
	archiveProgressByChat: {},
	error: null,
	hydrate: async (projectId) => {
		const lifecycle = currentChangeLifecycle(projectId);
		set((s) => ({
			loadingByProject: { ...s.loadingByProject, [projectId]: true },
			error: null,
		}));
		try {
			const client = await getRpcClient();
			const archiveJobsRpc = (
				client as typeof client & {
					readonly "chat.archiveJobs"?: (typeof client)["chat.archiveJobs"];
				}
			)["chat.archiveJobs"];
			const [chats, archiveJobs] = await Promise.all([
				Effect.runPromise(client["chat.list"]({ projectId })),
				archiveJobsRpc === undefined
					? Promise.resolve([])
					: Effect.runPromise(archiveJobsRpc({ projectId })),
			]);
			for (const job of archiveJobs) {
				if (job.status === "failed") notifyArchiveFailure(job);
				else monitorArchiveJob(job.chatId);
			}
			if (currentChangeLifecycle(projectId) !== lifecycle) return;
			set((s) => ({
				chatsByProject: { ...s.chatsByProject, [projectId]: chats },
				loadingByProject: { ...s.loadingByProject, [projectId]: false },
			}));
		} catch (err) {
			if (currentChangeLifecycle(projectId) !== lifecycle) return;
			set((s) => ({
				chatsByProject:
					s.chatsByProject[projectId] === undefined
						? { ...s.chatsByProject, [projectId]: [] }
						: s.chatsByProject,
				error: formatError(err),
				loadingByProject: { ...s.loadingByProject, [projectId]: false },
			}));
		} finally {
			// The stream has its own subscribe-before-snapshot backfill, so start it
			// even when the initial list RPC fails. The shared connection supervisor
			// controls retry/backoff and announces the next usable generation.
			ensureChangeStream(projectId, lifecycle);
		}
	},
	create: async (projectId, providerId, model, opts) => {
		const chatId = ChatId.make(`chat_${crypto.randomUUID()}`);
		const initialSessionId = SessionId.make(`s_${crypto.randomUUID()}`);
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
		let startupQueueId: string | null = null;
		batchAtomUpdates(() => {
			set((s) => ({
				error: null,
				creatingByProject: { ...s.creatingByProject, [projectId]: true },
				chatsByProject: {
					...s.chatsByProject,
					[projectId]: upsertChat(
						s.chatsByProject[projectId] ?? [],
						optimisticChat,
					),
				},
				selectedChatId: chatId,
				selectedChatByProject: {
					...s.selectedChatByProject,
					[projectId]: chatId,
				},
			}));
			useSessionsStore.setState((s) => ({
				sessionsByProject: {
					...s.sessionsByProject,
					[projectId]: [
						optimisticSession,
						...(s.sessionsByProject[projectId] ?? []),
					],
				},
				selectedSessionId: initialSessionId,
				selectedSessionByProject: {
					...s.selectedSessionByProject,
					[projectId]: initialSessionId,
				},
			}));
			if (opts?.startupInput !== undefined) {
				startupQueueId = useMessagesStore
					.getState()
					.queue(initialSessionId, opts.startupInput, { persist: false });
			}
		});
		markRendererInteraction(initialSessionId, "first-atom-commit");
		try {
			const worktreeId = await (opts?.worktreeId ?? null);
			const client = await getRpcClient();
			const result = await trackRendererRpc("chat.create", () =>
				Effect.runPromise(
					client["chat.create"]({
						chatId,
						initialSessionId,
						projectId,
						providerId,
						model,
						title: opts?.title,
						runtimeMode: opts?.runtimeMode,
						worktreeId,
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
				return {
					chatsByProject: {
						...s.chatsByProject,
						[projectId]: upsertChat(existing, chat),
					},
					selectedChatId: chat.id,
					selectedChatByProject: {
						...s.selectedChatByProject,
						[projectId]: chat.id,
					},
					creatingByProject: {
						...s.creatingByProject,
						[projectId]: false,
					},
				};
			});
			// Mirror the initial session into the sessions store and select it
			// so the chat surface (composer, message list, cost footer) wires up
			// on the very next render.
			useSessionsStore.setState((s) => {
				const list = s.sessionsByProject[projectId] ?? [];
				// The live chat stream can hydrate this row before create() resolves.
				// Deduplicate the row without dropping the selection transition.
				return {
					sessionsByProject: {
						...s.sessionsByProject,
						[projectId]: [
							initialSession,
							...list.filter((row) => row.id !== initialSession.id),
						],
					},
					selectedSessionId: initialSession.id,
					selectedSessionByProject: {
						...s.selectedSessionByProject,
						[projectId]: initialSession.id,
					},
				};
			});
			return {
				chatId: chat.id,
				initialSessionId: initialSession.id,
				startupQueueId,
			};
		} catch (err) {
			batchAtomUpdates(() => {
				if (startupQueueId !== null) {
					useMessagesStore
						.getState()
						.dropFromQueue(initialSessionId, startupQueueId);
				}
				useSessionsStore.setState((s) => ({
					sessionsByProject: {
						...s.sessionsByProject,
						[projectId]: (s.sessionsByProject[projectId] ?? []).filter(
							(row) => row.id !== initialSessionId,
						),
					},
					selectedSessionId:
						s.selectedSessionId === initialSessionId
							? previousSessionId
							: s.selectedSessionId,
					selectedSessionByProject: {
						...s.selectedSessionByProject,
						[projectId]: previousSessionId,
					},
				}));
				set((s) => ({
					error: formatError(err),
					chatsByProject: {
						...s.chatsByProject,
						[projectId]: (s.chatsByProject[projectId] ?? []).filter(
							(row) => row.id !== chatId,
						),
					},
					selectedChatId:
						s.selectedChatId === chatId ? previousChatId : s.selectedChatId,
					selectedChatByProject: {
						...s.selectedChatByProject,
						[projectId]: previousChatId,
					},
					creatingByProject: { ...s.creatingByProject, [projectId]: false },
				}));
			});
			return null;
		}
	},
	rename: async (chatId, title) => {
		set({ error: null });
		try {
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
