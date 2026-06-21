import { Effect } from "effect";
import { create } from "zustand";

import { Session } from "@memoize/wire";
import type {
  AgentItemId,
  ChatId,
  FolderId,
  PermissionMode,
  ProviderId,
  RuntimeMode,
  SessionId,
  UserQuestionAnswer,
} from "@memoize/wire";

import { getRpcClient } from "../lib/rpc-client.ts";
import { formatError } from "../lib/format-error.ts";
import {
  buildAgentsForNewSession,
  useSubagentsStore,
} from "./subagents.ts";
import { useWorkspaceStore } from "./workspace.ts";

/**
 * Per-project session catalog. Sessions are scoped to a project, archived
 * sessions are hidden by default, and `selectedSessionId` drives which
 * session the chat surface (PR 4) renders. Live message streaming is owned
 * by the messages store — this one is a sidebar-only view-model.
 */
type SessionsState = {
  readonly sessionsByProject: Record<string, ReadonlyArray<Session>>;
  /**
   * Mirror of `selectedSessionByProject[selectedFolderId]`. Kept as live state
   * (not a derived selector) so existing call sites can subscribe to it
   * directly without a per-render workspace lookup. Synced from
   * `selectedSessionByProject` by a workspace subscription at module init.
   */
  readonly selectedSessionId: SessionId | null;
  /**
   * Per-project last-selected session. Switching projects restores the
   * previously-active session for the new project so file tree, changes,
   * PR badge, terminal cwd, and the chat all swap together.
   */
  readonly selectedSessionByProject: Record<string, SessionId | null>;
  readonly showArchivedByProject: Record<string, boolean>;
  readonly loadingByProject: Record<string, boolean>;
  /**
   * Per-chat in-flight flag for `create()`. Drives the tab-strip "+"
   * button's icon + disabled state and the loading panel that takes over
   * the chat surface while a new tab is booting. Cleared when the RPC
   * resolves (success or failure) — note the server-side boot continues
   * after the RPC returns; the chat surface keeps showing the panel via
   * `Session.status === "booting"` until the provider handshake completes.
   */
  readonly creatingByChat: Record<string, boolean>;
  /**
   * Ephemeral, client-only session used to drive the real `ChatComposer` on
   * the new-chat landing before any chat/session/worktree exists. It is NOT
   * in `sessionsByProject`, so it never shows in the sidebar or tab strip —
   * the composer's model/runtime/permission/provider setters route here (see
   * the setters below) so the picks carry into `create()` on first send. The
   * `ChatComposer` for it runs with `onDraftSubmit`; nothing else touches it.
   */
  readonly draftSession: Session | null;
  readonly error: string | null;
  /** Spin up a fresh draft session for `ChatLanding`. Returns the row. */
  readonly beginDraft: (params: {
    projectId: FolderId;
    providerId: ProviderId;
    model: string;
    runtimeMode: RuntimeMode;
  }) => Session;
  /** Tear down the draft session (on submit handoff or landing unmount). */
  readonly clearDraft: () => void;
  readonly hydrate: (projectId: FolderId) => Promise<void>;
  readonly create: (
    chatId: ChatId,
    providerId: ProviderId,
    model: string,
    opts?: {
      initialPrompt?: string;
      runtimeMode?: RuntimeMode;
      permissionMode?: PermissionMode;
      toolSearch?: boolean;
    },
  ) => Promise<SessionId | null>;
  /**
   * Patch the cached `Session.status` for a session. Called by the
   * `session.streamStatus` subscription so the renderer's view of
   * `Session.status` reflects post-boot transitions
   * (`booting` → `idle` / `running` / `error`).
   */
  readonly setSessionStatus: (
    sessionId: SessionId,
    status: Session["status"],
  ) => void;
  readonly rename: (sessionId: SessionId, title: string) => Promise<void>;
  readonly setModel: (sessionId: SessionId, model: string) => Promise<void>;
  readonly setRuntimeMode: (
    sessionId: SessionId,
    runtimeMode: RuntimeMode,
  ) => Promise<void>;
  /**
   * Switch the SDK lifecycle mode (plan / default / acceptEdits) on a
   * live session. Optimistic — patches the local row before the RPC
   * settles so the chat-header chip flips instantly.
   */
  readonly setPermissionMode: (
    sessionId: SessionId,
    mode: PermissionMode,
  ) => Promise<void>;
  /**
   * Resolve a pending in-process AskUserQuestion call. Routes the
   * answers to the driver, which returns them as the tool result.
   */
  readonly answerQuestion: (
    sessionId: SessionId,
    itemId: AgentItemId,
    answers: ReadonlyArray<UserQuestionAnswer>,
  ) => Promise<void>;
  /**
   * Switch the session's provider and model. Allowed only before the first
   * user message — server returns `SessionAlreadyStartedError` otherwise,
   * surfaced here as `{ ok: false, reason }`. Worktree changes go through
   * `chats.setWorktree` instead — the chat owns the workspace binding.
   */
  readonly setProvider: (
    sessionId: SessionId,
    providerId: ProviderId,
    model: string,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; reason: string }>;
  readonly refreshOne: (sessionId: SessionId) => Promise<void>;
  readonly archive: (sessionId: SessionId) => Promise<void>;
  readonly unarchive: (sessionId: SessionId) => Promise<void>;
  readonly remove: (sessionId: SessionId) => Promise<void>;
  readonly resume: (sessionId: SessionId) => Promise<boolean>;
  readonly select: (sessionId: SessionId | null) => void;
  readonly toggleShowArchived: (projectId: FolderId) => void;
};

/**
 * Sentinel ids for the landing's draft session. Fixed (not random) so the
 * composer's `key` stays stable across re-renders and the setter routing can
 * recognise the draft by id without threading a flag through every toggle.
 */
export const DRAFT_SESSION_ID = "draft-session" as SessionId;
export const DRAFT_CHAT_ID = "draft-chat" as ChatId;

const findSessionProject = (
  sessionsByProject: SessionsState["sessionsByProject"],
  sessionId: SessionId,
): FolderId | null => {
  for (const [pid, sessions] of Object.entries(sessionsByProject)) {
    if (sessions.some((s) => s.id === sessionId)) return pid as FolderId;
  }
  return null;
};

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessionsByProject: {},
  selectedSessionId: null,
  selectedSessionByProject: {},
  showArchivedByProject: {},
  loadingByProject: {},
  creatingByChat: {},
  draftSession: null,
  error: null,
  beginDraft: ({ projectId, providerId, model, runtimeMode }) => {
    const now = new Date();
    const draft = Session.make({
      id: DRAFT_SESSION_ID,
      projectId,
      title: "New chat",
      providerId,
      model,
      status: "idle",
      archivedAt: null,
      cursor: null,
      resumeStrategy: "none",
      runtimeMode,
      worktreeId: null,
      chatId: DRAFT_CHAT_ID,
      forkedFromSessionId: null,
      forkedFromMessageId: null,
      permissionMode: "default",
      toolSearch: false,
      createdAt: now,
      updatedAt: now,
    });
    set({ draftSession: draft });
    return draft;
  },
  clearDraft: () => set({ draftSession: null }),
  hydrate: async (projectId) => {
    set((s) => ({
      loadingByProject: { ...s.loadingByProject, [projectId]: true },
      error: null,
    }));
    try {
      const client = await getRpcClient();
      const includeArchived =
        get().showArchivedByProject[projectId] === true;
      const sessions = await Effect.runPromise(
        client.session.list({ projectId, includeArchived }),
      );
      set((s) => ({
        sessionsByProject: { ...s.sessionsByProject, [projectId]: sessions },
        loadingByProject: { ...s.loadingByProject, [projectId]: false },
      }));
    } catch (err) {
      set((s) => ({
        error: formatError(err),
        loadingByProject: { ...s.loadingByProject, [projectId]: false },
      }));
    }
  },
  create: async (chatId, providerId, model, opts) => {
    set((s) => ({
      error: null,
      creatingByChat: { ...s.creatingByChat, [chatId]: true },
    }));
    try {
      const client = await getRpcClient();
      // Sub-agent presets are Claude-only this PR — Codex sessions ship
      // empty `agents` so the wire stays uniform.
      const agents =
        providerId === "claude" ? buildAgentsForNewSession() : {};
      const enableSubagents =
        providerId === "claude" &&
        useSubagentsStore.getState().enableForNewSessions;
      const session = await Effect.runPromise(
        client.session.create({
          chatId,
          providerId,
          model,
          initialPrompt: opts?.initialPrompt,
          runtimeMode: opts?.runtimeMode,
          agents,
          enableSubagents,
          permissionMode: opts?.permissionMode,
          toolSearch: opts?.toolSearch,
        }),
      );
      const projectId = session.projectId;
      set((s) => {
        const existing = s.sessionsByProject[projectId] ?? [];
        return {
          sessionsByProject: {
            ...s.sessionsByProject,
            [projectId]: [session, ...existing],
          },
          selectedSessionId: session.id,
          selectedSessionByProject: {
            ...s.selectedSessionByProject,
            [projectId]: session.id,
          },
          creatingByChat: { ...s.creatingByChat, [chatId]: false },
        };
      });
      return session.id;
    } catch (err) {
      set((s) => ({
        error: formatError(err),
        creatingByChat: { ...s.creatingByChat, [chatId]: false },
      }));
      return null;
    }
  },
  setSessionStatus: (sessionId, status) => {
    set((s) => {
      const projectId = findSessionProject(s.sessionsByProject, sessionId);
      if (projectId === null) return s;
      const list = s.sessionsByProject[projectId] ?? [];
      let changed = false;
      const next = list.map((row) => {
        if (row.id !== sessionId || row.status === status) return row;
        changed = true;
        return { ...row, status } as Session;
      });
      if (!changed) return s;
      return {
        sessionsByProject: {
          ...s.sessionsByProject,
          [projectId]: next,
        },
      };
    });
  },
  rename: async (sessionId, title) => {
    set({ error: null });
    try {
      const client = await getRpcClient();
      await Effect.runPromise(client.session.rename({ sessionId, title }));
      set((s) => {
        const projectId = findSessionProject(s.sessionsByProject, sessionId);
        if (projectId === null) return {};
        const sessions = s.sessionsByProject[projectId] ?? [];
        return {
          sessionsByProject: {
            ...s.sessionsByProject,
            [projectId]: sessions.map((session) =>
              session.id === sessionId ? { ...session, title } : session,
            ),
          },
        };
      });
    } catch (err) {
      set({ error: formatError(err) });
    }
  },
  setModel: async (sessionId, model) => {
    const draft = get().draftSession;
    if (draft !== null && draft.id === sessionId) {
      set({ draftSession: Session.make({ ...draft, model }) });
      return;
    }
    set({ error: null });
    try {
      const client = await getRpcClient();
      await Effect.runPromise(client.session.setModel({ sessionId, model }));
      set((s) => {
        const projectId = findSessionProject(s.sessionsByProject, sessionId);
        if (projectId === null) return {};
        const sessions = s.sessionsByProject[projectId] ?? [];
        return {
          sessionsByProject: {
            ...s.sessionsByProject,
            [projectId]: sessions.map((session) =>
              session.id === sessionId ? { ...session, model } : session,
            ),
          },
        };
      });
    } catch (err) {
      set({ error: formatError(err) });
    }
  },
  setRuntimeMode: async (sessionId, runtimeMode) => {
    const draft = get().draftSession;
    if (draft !== null && draft.id === sessionId) {
      set({ draftSession: Session.make({ ...draft, runtimeMode }) });
      return;
    }
    // Optimistic — patch the local row before the RPC settles so the toggle
    // feels instant. Server-side update is also fast (single SQL UPDATE +
    // in-memory cache poke), so the round-trip is invisible in practice.
    set((s) => {
      const projectId = findSessionProject(s.sessionsByProject, sessionId);
      if (projectId === null) return { error: null };
      const sessions = s.sessionsByProject[projectId] ?? [];
      return {
        error: null,
        sessionsByProject: {
          ...s.sessionsByProject,
          [projectId]: sessions.map((session) =>
            session.id === sessionId ? { ...session, runtimeMode } : session,
          ),
        },
      };
    });
    try {
      const client = await getRpcClient();
      await Effect.runPromise(
        client.session.setRuntimeMode({ sessionId, runtimeMode }),
      );
    } catch (err) {
      set({ error: formatError(err) });
      // Best-effort revert via re-hydrate of the affected project.
      const projectId = findSessionProject(get().sessionsByProject, sessionId);
      if (projectId !== null) await get().hydrate(projectId);
    }
  },
  setPermissionMode: async (sessionId, mode) => {
    const draft = get().draftSession;
    if (draft !== null && draft.id === sessionId) {
      set({ draftSession: Session.make({ ...draft, permissionMode: mode }) });
      return;
    }
    set((s) => {
      const projectId = findSessionProject(s.sessionsByProject, sessionId);
      if (projectId === null) return { error: null };
      const sessions = s.sessionsByProject[projectId] ?? [];
      return {
        error: null,
        sessionsByProject: {
          ...s.sessionsByProject,
          [projectId]: sessions.map((session) =>
            session.id === sessionId
              ? { ...session, permissionMode: mode }
              : session,
          ),
        },
      };
    });
    try {
      const client = await getRpcClient();
      await Effect.runPromise(
        client.session.setPermissionMode({ sessionId, mode }),
      );
    } catch (err) {
      set({ error: formatError(err) });
      const projectId = findSessionProject(get().sessionsByProject, sessionId);
      if (projectId !== null) await get().hydrate(projectId);
    }
  },
  answerQuestion: async (sessionId, itemId, answers) => {
    set({ error: null });
    try {
      const client = await getRpcClient();
      await Effect.runPromise(
        client.session.answerQuestion({ sessionId, itemId, answers }),
      );
    } catch (err) {
      set({ error: formatError(err) });
    }
  },
  setProvider: async (sessionId, providerId, model) => {
    const draft = get().draftSession;
    if (draft !== null && draft.id === sessionId) {
      set({ draftSession: Session.make({ ...draft, providerId, model }) });
      return { ok: true } as const;
    }
    set({ error: null });
    try {
      const client = await getRpcClient();
      await Effect.runPromise(
        client.session.setProvider({ sessionId, providerId, model }),
      );
      set((s) => {
        const projectId = findSessionProject(s.sessionsByProject, sessionId);
        if (projectId === null) return {};
        const sessions = s.sessionsByProject[projectId] ?? [];
        return {
          sessionsByProject: {
            ...s.sessionsByProject,
            [projectId]: sessions.map((session) =>
              session.id === sessionId
                ? { ...session, providerId, model }
                : session,
            ),
          },
        };
      });
      return { ok: true } as const;
    } catch (err) {
      const raw = formatError(err);
      const reason =
        raw === "SessionAlreadyStartedError"
          ? "Start a new chat to switch provider."
          : raw;
      set({ error: reason });
      return { ok: false, reason } as const;
    }
  },
  archive: async (sessionId) => {
    set({ error: null });
    try {
      const client = await getRpcClient();
      await Effect.runPromise(client.session.archive({ sessionId }));
      // Re-hydrate the affected project so visibility honors showArchived.
      const projectId = findSessionProject(get().sessionsByProject, sessionId);
      if (projectId !== null) await get().hydrate(projectId);
      set((s) => {
        const wasSelected = s.selectedSessionId === sessionId;
        const clearPerProject =
          projectId !== null &&
          s.selectedSessionByProject[projectId] === sessionId;
        if (!wasSelected && !clearPerProject) return s;
        return {
          selectedSessionId: wasSelected ? null : s.selectedSessionId,
          selectedSessionByProject: clearPerProject
            ? { ...s.selectedSessionByProject, [projectId!]: null }
            : s.selectedSessionByProject,
        };
      });
    } catch (err) {
      set({ error: formatError(err) });
    }
  },
  unarchive: async (sessionId) => {
    set({ error: null });
    try {
      const client = await getRpcClient();
      await Effect.runPromise(client.session.unarchive({ sessionId }));
      const projectId = findSessionProject(get().sessionsByProject, sessionId);
      if (projectId !== null) await get().hydrate(projectId);
    } catch (err) {
      set({ error: formatError(err) });
    }
  },
  remove: async (sessionId) => {
    set({ error: null });
    try {
      const client = await getRpcClient();
      await Effect.runPromise(client.session.delete({ sessionId }));
      const projectId = findSessionProject(get().sessionsByProject, sessionId);
      set((s) => {
        if (projectId === null) return {};
        const sessions = s.sessionsByProject[projectId] ?? [];
        const perProject = s.selectedSessionByProject[projectId] === sessionId
          ? { ...s.selectedSessionByProject, [projectId]: null }
          : s.selectedSessionByProject;
        return {
          sessionsByProject: {
            ...s.sessionsByProject,
            [projectId]: sessions.filter((session) => session.id !== sessionId),
          },
          selectedSessionId:
            s.selectedSessionId === sessionId ? null : s.selectedSessionId,
          selectedSessionByProject: perProject,
        };
      });
    } catch (err) {
      set({ error: formatError(err) });
    }
  },
  resume: async (sessionId) => {
    set({ error: null });
    try {
      const client = await getRpcClient();
      const session = await Effect.runPromise(
        client.session.resume({ sessionId }),
      );
      set((s) => {
        const projectId = findSessionProject(s.sessionsByProject, sessionId);
        if (projectId === null) return {};
        const sessions = s.sessionsByProject[projectId] ?? [];
        return {
          sessionsByProject: {
            ...s.sessionsByProject,
            [projectId]: sessions.map((existing) =>
              existing.id === sessionId ? session : existing,
            ),
          },
          selectedSessionId: session.id,
          selectedSessionByProject: {
            ...s.selectedSessionByProject,
            [projectId]: session.id,
          },
        };
      });
      return true;
    } catch (err) {
      set({ error: formatError(err) });
      return false;
    }
  },
  refreshOne: async (sessionId) => {
    try {
      const client = await getRpcClient();
      const session = await Effect.runPromise(
        client.session.get({ sessionId }),
      );
      set((s) => {
        const projectId = findSessionProject(s.sessionsByProject, sessionId);
        if (projectId === null) return {};
        const sessions = s.sessionsByProject[projectId] ?? [];
        return {
          sessionsByProject: {
            ...s.sessionsByProject,
            [projectId]: sessions.map((existing) =>
              existing.id === sessionId ? session : existing,
            ),
          },
        };
      });
    } catch {
      // Silent — refreshOne is a best-effort follow-up after send().
    }
  },
  select: (sessionId) => {
    if (sessionId === null) {
      set((s) => {
        const activeProjectId = useWorkspaceStore.getState().selectedFolderId;
        return {
          selectedSessionId: null,
          selectedSessionByProject:
            activeProjectId !== null
              ? { ...s.selectedSessionByProject, [activeProjectId]: null }
              : s.selectedSessionByProject,
        };
      });
      return;
    }
    const projectId = findSessionProject(get().sessionsByProject, sessionId);
    // Write the per-project slot FIRST so the workspace.select below sees
    // the freshly-set slot when its subscriber fires — otherwise the
    // subscriber would briefly mirror the stale slot value.
    set((s) => ({
      selectedSessionId: sessionId,
      selectedSessionByProject:
        projectId !== null
          ? { ...s.selectedSessionByProject, [projectId]: sessionId }
          : s.selectedSessionByProject,
    }));
    // Mirror the active tab into the owning chat row so a later sidebar
    // click restores this tab. Lookup is best-effort — we skip when the
    // session row hasn't hit the renderer cache yet (e.g. just-created
    // session whose hydrate is still in flight).
    const sessionRow =
      projectId !== null
        ? get().sessionsByProject[projectId]?.find((row) => row.id === sessionId)
        : undefined;
    if (sessionRow !== undefined) {
      // Lazy require to dodge an import cycle with chats.ts which depends
      // on this store.
      void import("./chats.ts").then(({ useChatsStore }) =>
        useChatsStore.getState().setActiveSession(sessionRow.chatId, sessionId),
      );
    }
    // If the session lives in a different project than the currently-active
    // one, switch projects too. Without this the chat would jump to the new
    // session but the right pane, top bar, terminal cwd, etc. would stay on
    // the old project — the "click does nothing visible" symptom.
    if (
      projectId !== null &&
      useWorkspaceStore.getState().selectedFolderId !== projectId
    ) {
      void useWorkspaceStore.getState().select(projectId);
    }
  },
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

// Mirror `selectedSessionId` from the active project's per-project slot.
// Switching projects automatically restores whichever session was last
// selected for the new project; if none, the chat clears (no stale session
// from the previous project leaks across).
useWorkspaceStore.subscribe((ws, prev) => {
  if (ws.selectedFolderId === prev.selectedFolderId) return;
  const slot =
    ws.selectedFolderId !== null
      ? useSessionsStore.getState().selectedSessionByProject[ws.selectedFolderId] ?? null
      : null;
  if (useSessionsStore.getState().selectedSessionId !== slot) {
    useSessionsStore.setState({ selectedSessionId: slot });
  }
});
