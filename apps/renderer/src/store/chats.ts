import { Effect, Fiber, Stream } from "effect";
import { create } from "zustand";

import type {
  AgentDefinition,
  Chat,
  ChatId,
  FolderId,
  PermissionMode,
  ProviderId,
  RuntimeMode,
  Session,
  SessionId,
  WorktreeId,
} from "@zuse/wire";

import { toastManager } from "../components/ui/toast.tsx";
import { getRpcClient } from "../lib/rpc-client.ts";
import { formatError } from "../lib/format-error.ts";
import { useMessagesStore } from "./messages.ts";
import { useSessionsStore } from "./sessions.ts";
import { useTerminalsStore } from "./terminals.ts";
import { useUiStore } from "./ui.ts";
import { useWorkspaceStore } from "./workspace.ts";
import { useWorktreesStore } from "./worktrees.ts";

export type ChatArchiveProgressPhase = "archiving" | "removing-dirty-worktree";

export const chatArchiveProgressLabel = (
  phase: ChatArchiveProgressPhase,
): string =>
  phase === "removing-dirty-worktree"
    ? "Removing dirty worktree…"
    : "Archiving chat…";

const FORCED_ARCHIVE_TOAST_DELAY_MS = 700;
const DIRTY_ARCHIVE_CONFIRM_MESSAGE =
  "This chat's worktree has uncommitted changes. Discard them and archive anyway?";

type ArchiveDirtyConfirm = () => Promise<boolean>;

const defaultArchiveDirtyConfirm: ArchiveDirtyConfirm = () => {
  if (typeof window === "undefined") return Promise.resolve(false);
  return Promise.resolve(window.confirm(DIRTY_ARCHIVE_CONFIRM_MESSAGE));
};

let archiveDirtyConfirm: ArchiveDirtyConfirm = defaultArchiveDirtyConfirm;

export const setArchiveDirtyConfirm = (
  confirm: ArchiveDirtyConfirm,
): void => {
  archiveDirtyConfirm = confirm;
};

export const resetArchiveDirtyConfirm = (): void => {
  archiveDirtyConfirm = defaultArchiveDirtyConfirm;
};

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
  readonly showArchivedByProject: Record<string, boolean>;
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
      readonly initialPrompt?: string;
      readonly runtimeMode?: RuntimeMode;
      readonly worktreeId?: WorktreeId | null;
      readonly agents?: Readonly<Record<string, AgentDefinition>>;
      readonly enableSubagents?: boolean;
      readonly permissionMode?: PermissionMode;
      readonly toolSearch?: boolean;
    },
  ) => Promise<{
    readonly chatId: ChatId;
    readonly initialSessionId: SessionId;
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
    | { readonly ok: true }
    | { readonly ok: false; readonly dirty: boolean; readonly reason: string }
  >;
  readonly setArchiveProgress: (
    chatId: ChatId,
    phase: ChatArchiveProgressPhase,
  ) => void;
  readonly clearArchiveProgress: (chatId: ChatId) => void;
  readonly unarchive: (chatId: ChatId) => Promise<void>;
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
  readonly toggleShowArchived: (projectId: FolderId) => void;
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

const findChatProject = (
  chatsByProject: ChatsState["chatsByProject"],
  chatId: ChatId,
): FolderId | null => {
  for (const [pid, chats] of Object.entries(chatsByProject)) {
    if (chats.some((c) => c.id === chatId)) return pid as FolderId;
  }
  return null;
};

/**
 * Live `chat.streamChanges` subscription per project — one long-lived fiber
 * keyed by projectId. Carries server-side chat-row patches (notably the
 * background auto-namer rewriting a new chat's title after its first
 * message) so the sidebar updates without a manual refetch.
 */
const changeFibers = new Map<string, Fiber.RuntimeFiber<unknown, unknown>>();

const ensureChangeStream = (projectId: FolderId): void => {
  if (changeFibers.has(projectId)) return;
  // Reserve the slot synchronously so concurrent hydrate() calls don't race
  // two subscriptions onto the same project.
  changeFibers.set(
    projectId,
    Effect.runFork(
      Effect.flatMap(
        Effect.promise(() => getRpcClient()),
        (client) =>
          Stream.runForEach(client.chat.streamChanges({ projectId }), (chat) =>
            Effect.sync(() => {
              useChatsStore.setState((s) => {
                const chats = s.chatsByProject[projectId];
                if (chats === undefined) return s;
                if (!chats.some((c) => c.id === chat.id)) {
                  void useSessionsStore.getState().hydrate(projectId);
                  return {
                    chatsByProject: {
                      ...s.chatsByProject,
                      [projectId]: [chat, ...chats],
                    },
                  };
                }
                return {
                  chatsByProject: {
                    ...s.chatsByProject,
                    [projectId]: chats.map((c) =>
                      c.id === chat.id ? chat : c,
                    ),
                  },
                };
              });
              // Mirror the server-side auto-namer onto member session tabs.
              useSessionsStore.setState((s) => {
                const sessions = s.sessionsByProject[projectId];
                if (sessions === undefined) return s;
                if (!sessions.some((row) => row.chatId === chat.id)) return s;
                return {
                  sessionsByProject: {
                    ...s.sessionsByProject,
                    [projectId]: sessions.map((row) =>
                      row.chatId === chat.id
                        ? { ...row, title: chat.title }
                        : row,
                    ),
                  },
                };
              });
            }),
          ),
      ),
    ),
  );
};

export const useChatsStore = create<ChatsState>((set, get) => ({
  chatsByProject: {},
  selectedChatId: null,
  selectedChatByProject: {},
  showArchivedByProject: {},
  loadingByProject: {},
  creatingByProject: {},
  archiveProgressByChat: {},
  error: null,
  hydrate: async (projectId) => {
    set((s) => ({
      loadingByProject: { ...s.loadingByProject, [projectId]: true },
      error: null,
    }));
    try {
      const client = await getRpcClient();
      const includeArchived = get().showArchivedByProject[projectId] === true;
      const chats = await Effect.runPromise(
        client.chat.list({ projectId, includeArchived }),
      );
      set((s) => ({
        chatsByProject: { ...s.chatsByProject, [projectId]: chats },
        loadingByProject: { ...s.loadingByProject, [projectId]: false },
      }));
      // Begin (or keep) the live change subscription now that the list is
      // seeded — patches only land for chats already in the list.
      ensureChangeStream(projectId);
    } catch (err) {
      set((s) => ({
        error: formatError(err),
        loadingByProject: { ...s.loadingByProject, [projectId]: false },
      }));
    }
  },
  create: async (projectId, providerId, model, opts) => {
    set((s) => ({
      error: null,
      creatingByProject: { ...s.creatingByProject, [projectId]: true },
    }));
    try {
      const client = await getRpcClient();
      const result = await Effect.runPromise(
        client.chat.create({
          projectId,
          providerId,
          model,
          title: opts?.title,
          initialPrompt: opts?.initialPrompt,
          runtimeMode: opts?.runtimeMode,
          worktreeId: opts?.worktreeId ?? null,
          agents: opts?.agents,
          enableSubagents: opts?.enableSubagents,
          permissionMode: opts?.permissionMode,
          toolSearch: opts?.toolSearch,
        }),
      );
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
            [projectId]: [chat, ...existing],
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
        if (list.some((row) => row.id === initialSession.id)) return s;
        return {
          sessionsByProject: {
            ...s.sessionsByProject,
            [projectId]: [initialSession, ...list],
          },
          selectedSessionId: initialSession.id,
          selectedSessionByProject: {
            ...s.selectedSessionByProject,
            [projectId]: initialSession.id,
          },
        };
      });
      return { chatId: chat.id, initialSessionId: initialSession.id };
    } catch (err) {
      set((s) => ({
        error: formatError(err),
        creatingByProject: { ...s.creatingByProject, [projectId]: false },
      }));
      return null;
    }
  },
  rename: async (chatId, title) => {
    set({ error: null });
    try {
      const client = await getRpcClient();
      await Effect.runPromise(client.chat.rename({ chatId, title }));
      set((s) => {
        const projectId = findChatProject(s.chatsByProject, chatId);
        if (projectId === null) return {};
        const chats = s.chatsByProject[projectId] ?? [];
        return {
          chatsByProject: {
            ...s.chatsByProject,
            [projectId]: chats.map((c) =>
              c.id === chatId
                ? Object.assign(Object.create(Object.getPrototypeOf(c)), c, {
                    title,
                  })
                : c,
            ),
          },
        };
      });
    } catch (err) {
      set({ error: formatError(err) });
    }
  },
  setWorktree: async (chatId, worktreeId) => {
    set({ error: null });
    try {
      const client = await getRpcClient();
      const chat = await Effect.runPromise(
        client.chat.setWorktree({ chatId, worktreeId }),
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
        client.chat.setActiveSession({ chatId, sessionId }),
      );
    } catch (err) {
      set({ error: formatError(err) });
    }
  },
  archive: async (chatId, force = false) => {
    set({ error: null });
    try {
      const client = await getRpcClient();
      const result = await Effect.runPromise(
        client.chat.archive({ chatId, force }),
      );
      const projectId = findChatProject(get().chatsByProject, chatId);
      if (projectId !== null) {
        set((s) => {
          const chats = s.chatsByProject[projectId] ?? [];
          return {
            chatsByProject: {
              ...s.chatsByProject,
              [projectId]: chats.map((chat) =>
                chat.id === chatId ? result.chat : chat,
              ),
            },
          };
        });
      }
      if (projectId !== null) await get().hydrate(projectId);
      if (projectId !== null) {
        await useWorktreesStore.getState().refresh(projectId);
      }
      // Drop the chat from the active selection so the chat surface clears.
      set((s) => {
        const wasSelected = s.selectedChatId === chatId;
        const clearPerProject =
          projectId !== null && s.selectedChatByProject[projectId] === chatId;
        if (!wasSelected && !clearPerProject) return s;
        return {
          selectedChatId: wasSelected ? null : s.selectedChatId,
          selectedChatByProject: clearPerProject
            ? { ...s.selectedChatByProject, [projectId!]: null }
            : s.selectedChatByProject,
        };
      });
      // Also drop the matching sessions from the renderer cache so the
      // tab strip empties immediately.
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
      // Tear down the chat's terminals (closing their PTYs) and drop its dock
      // layout so an archived chat leaks no shells or tab state.
      useTerminalsStore.getState().disposeChat(chatId);
      useUiStore.getState().clearChatPanels(chatId);
      return { ok: true } as const;
    } catch (err) {
      const reason = formatError(err);
      // A dirty worktree blocks removal; the caller can re-issue with
      // `force: true` after confirming the discard with the user.
      const dirty =
        !force &&
        (reason.includes("WorktreeDirtyError") ||
          reason.toLowerCase().includes("dirty"));
      // Keep the dirty case out of the global error banner — the caller owns
      // the confirm-and-retry flow. Surface every other failure as before.
      set({ error: dirty ? null : reason });
      return { ok: false, dirty, reason } as const;
    }
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
  unarchive: async (chatId) => {
    set({ error: null });
    try {
      const client = await getRpcClient();
      const result = await Effect.runPromise(client.chat.unarchive({ chatId }));
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
      if (result.worktree !== null) {
        await useWorktreesStore.getState().refresh(resolvedProjectId);
      }
      if (projectId !== null) await get().hydrate(projectId);
    } catch (err) {
      set({ error: formatError(err) });
    }
  },
  remove: async (chatId) => {
    set({ error: null });
    try {
      const client = await getRpcClient();
      await Effect.runPromise(client.chat.delete({ chatId }));
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
      const updated = await Effect.runPromise(client.chat.markRead({ chatId }));
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
  toggleShowArchived: (projectId) => {
    set((s) => ({
      showArchivedByProject: {
        ...s.showArchivedByProject,
        [projectId]: !s.showArchivedByProject[projectId],
      },
    }));
    void get().hydrate(projectId);
  },
}));

/**
 * Archive a chat, surfacing the dirty-worktree case as a confirm prompt.
 * Mirrors the settings page's force-remove flow: when the chat's worktree has
 * uncommitted/untracked changes, ask the user to confirm discarding them, then
 * retry with `force: true`. Resolves quietly when the user declines; throws on
 * any other failure so button-level error UI can surface it.
 */
export async function archiveChatWithConfirm(chatId: ChatId): Promise<void> {
  const { archive, setArchiveProgress, clearArchiveProgress } =
    useChatsStore.getState();
  let forcedToastShown = false;
  let forcedToastTimer: ReturnType<typeof setTimeout> | null = null;
  const clearForcedToastTimer = (): void => {
    if (forcedToastTimer === null) return;
    clearTimeout(forcedToastTimer);
    forcedToastTimer = null;
  };

  setArchiveProgress(chatId, "archiving");
  try {
    const first = await archive(chatId);
    if (first.ok) return;
    if (!first.dirty) throw new Error(first.reason);
    const confirmed = await archiveDirtyConfirm();
    if (!confirmed) return;

    setArchiveProgress(chatId, "removing-dirty-worktree");
    forcedToastTimer = setTimeout(() => {
      forcedToastShown = true;
      toastManager.add({
        type: "loading",
        title: "Removing dirty worktree…",
        description: "Discarding local changes and deleting the checkout.",
      });
    }, FORCED_ARCHIVE_TOAST_DELAY_MS);

    const forced = await archive(chatId, true);
    clearForcedToastTimer();
    if (!forced.ok) throw new Error(forced.reason);
    if (forcedToastShown) {
      toastManager.add({
        type: "success",
        title: "Worktree removed",
        description: "The dirty checkout was discarded and archived.",
      });
    }
  } catch (err) {
    clearForcedToastTimer();
    if (forcedToastShown) {
      toastManager.add({
        type: "error",
        title: "Archive failed",
        description: formatError(err),
      });
    }
    throw err;
  } finally {
    clearForcedToastTimer();
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
