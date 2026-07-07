import { Effect, Fiber, Stream } from "effect";
import { create } from "zustand";

import {
  type FolderId,
  Worktree,
  type WorktreeCreateSource,
  type WorktreeId,
  type WorktreeSetupEvent,
} from "@zuse/wire";

import { toastManager } from "../components/ui/toast.tsx";
import { formatError } from "../lib/format-error.ts";
import { getRpcClient } from "../lib/rpc-client.ts";
import { openTerminalCommand } from "../lib/run-terminal.ts";
import { useChatsStore } from "./chats.ts";
import { useMessagesStore } from "./messages.ts";
import { useRepositorySettingsStore } from "./repository-settings.ts";
import { useSessionsStore } from "./sessions.ts";

/** Rarities worth interrupting the user with a one-off unlock toast. */
const NOTABLE_RARITIES: ReadonlySet<string> = new Set([
  "rare",
  "epic",
  "legendary",
]);

type WorktreesByProject = Readonly<Record<string, ReadonlyArray<Worktree>>>;

/**
 * Stable reference for "no worktrees yet" so selectors written as
 * `s.byProject[projectId] ?? EMPTY` don't return a new array each render
 * — that would invalidate zustand's `Object.is` snapshot and trigger a
 * `getSnapshot` infinite loop in React 19.
 */
export const EMPTY_WORKTREES: ReadonlyArray<Worktree> = Object.freeze([]);

type WorktreesState = {
  readonly byProject: WorktreesByProject;
  readonly loading: ReadonlySet<FolderId>;
  readonly creatingSetupByProject: ReadonlySet<FolderId>;
  readonly setupPending: ReadonlySet<WorktreeId>;
  readonly error: string | null;
  readonly refresh: (projectId: FolderId) => Promise<void>;
  readonly create: (
    projectId: FolderId,
    source?: WorktreeCreateSource,
  ) => Promise<Worktree | null>;
  readonly rerunSetup: (
    projectId: FolderId,
    worktreeId: WorktreeId,
  ) => Promise<Worktree | null>;
  /**
   * Drain a worktree's live `setupStream`, patching `setupStatus`/`setupOutput`
   * as events arrive. Idempotent; auto-stops when setup completes. On a
   * terminal status it kicks `maybeAutoRun` + flushes queued messages.
   */
  readonly subscribeSetup: (
    projectId: FolderId,
    worktreeId: WorktreeId,
  ) => void;
  readonly unsubscribeSetup: (worktreeId: WorktreeId) => void;
  readonly startRun: (worktreeId: WorktreeId) => Promise<{
    readonly cwd: string;
    readonly script: string;
    readonly env: Record<string, string>;
  } | null>;
  readonly remove: (
    projectId: FolderId,
    worktreeId: WorktreeId,
    force: boolean,
  ) => Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly dirty: boolean; readonly reason: string }
  >;
};

let getWorktreesRpcClient: typeof getRpcClient = getRpcClient;

export const setWorktreesRpcClientForTest = (fn: typeof getRpcClient): void => {
  getWorktreesRpcClient = fn;
};

const isWorktreeDirtyError = (err: unknown, formatted: string): boolean => {
  if (
    typeof err === "object" &&
    err !== null &&
    "_tag" in err &&
    err._tag === "WorktreeDirtyError"
  ) {
    return true;
  }
  if (err instanceof Error && err.name === "WorktreeDirtyError") return true;
  return (
    formatted.includes("WorktreeDirtyError") ||
    formatted.toLowerCase().includes("dirty") ||
    formatted.toLowerCase().includes("uncommitted changes")
  );
};

const maybeAutoRun = async (projectId: FolderId, wt: Worktree) => {
  const settings =
    useRepositorySettingsStore.getState().byProject[projectId] ??
    (await useRepositorySettingsStore.getState().refresh(projectId));
  if (settings?.autoRunAfterSetup !== true) return;
  if (wt.setupStatus !== "succeeded" && wt.setupStatus !== "skipped") return;
  // Terminals are per chat — surface the auto-run in the chat that owns this
  // worktree. Without one (none bound it), there's no dock to land it in.
  const chat = (useChatsStore.getState().chatsByProject[projectId] ?? []).find(
    (c) => c.worktreeId === wt.id,
  );
  if (chat === undefined) return;
  const run = await useWorktreesStore.getState().startRun(wt.id);
  if (run === null) return;
  openTerminalCommand({
    chatId: chat.id,
    cwd: run.cwd,
    title: "Run",
    command: { cmd: "/bin/zsh", args: ["-lc", run.script], env: run.env },
  });
};

/**
 * Fibers draining each worktree's live `setupStream`, keyed by worktreeId, so
 * a subscription is started at most once and interrupted on completion/removal.
 */
const setupFibers = new Map<WorktreeId, Fiber.RuntimeFiber<unknown, unknown>>();
const subscribingSetup = new Set<WorktreeId>();

const TERMINAL_SETUP = new Set(["succeeded", "failed", "skipped"]);

/**
 * Once setup reaches a terminal status, flush any messages queued against
 * sessions bound to this worktree — this is what makes the first message wait
 * for setup before the agent runs. Flush regardless of success/failure so a
 * failed setup never strands the user's message.
 */
const flushQueuedForWorktree = (worktreeId: WorktreeId): void => {
  const sessions = useSessionsStore.getState().sessionsByProject;
  const flush = useMessagesStore.getState().flushQueue;
  for (const list of Object.values(sessions)) {
    for (const session of list) {
      if (session.worktreeId === worktreeId) flush(session.id);
    }
  }
};

export const useWorktreesStore = create<WorktreesState>((set, get) => ({
  byProject: {},
  loading: new Set(),
  creatingSetupByProject: new Set(),
  setupPending: new Set(),
  error: null,
  refresh: async (projectId) => {
    set((s) => {
      const next = new Set(s.loading);
      next.add(projectId);
      return { loading: next };
    });
    try {
      const client = await getWorktreesRpcClient();
      const list = await Effect.runPromise(client.worktree.list({ projectId }));
      set((s) => ({
        byProject: { ...s.byProject, [projectId]: list },
        loading: (() => {
          const n = new Set(s.loading);
          n.delete(projectId);
          return n;
        })(),
        error: null,
      }));
    } catch (err) {
      set((s) => ({
        loading: (() => {
          const n = new Set(s.loading);
          n.delete(projectId);
          return n;
        })(),
        error: formatError(err),
      }));
    }
  },
  create: async (projectId, source) => {
    set((s) => {
      const next = new Set(s.creatingSetupByProject);
      next.add(projectId);
      return { creatingSetupByProject: next };
    });
    try {
      const client = await getWorktreesRpcClient();
      const wt = await Effect.runPromise(
        client.worktree.create(
          source === undefined ? { projectId } : { projectId, source },
        ),
      );
      set((s) => {
        const existing = s.byProject[projectId] ?? [];
        return {
          byProject: { ...s.byProject, [projectId]: [wt, ...existing] },
          creatingSetupByProject: (() => {
            const next = new Set(s.creatingSetupByProject);
            next.delete(projectId);
            return next;
          })(),
          error: null,
        };
      });
      if (wt.pokemon !== null && NOTABLE_RARITIES.has(wt.pokemon.rarity)) {
        const rarity =
          wt.pokemon.rarity.charAt(0).toUpperCase() +
          wt.pokemon.rarity.slice(1);
        toastManager.add({
          title: `${rarity} unlock!`,
          description: `${wt.pokemon.name} joined your Pokédex`,
          type: "success",
        });
      }
      // Setup now runs detached on the server; follow it live and let the
      // stream's terminal-status handler fire maybeAutoRun + flush.
      get().subscribeSetup(projectId, wt.id);
      return wt;
    } catch (err) {
      set((s) => {
        const next = new Set(s.creatingSetupByProject);
        next.delete(projectId);
        return { creatingSetupByProject: next, error: formatError(err) };
      });
      return null;
    }
  },
  rerunSetup: async (projectId, worktreeId) => {
    set((s) => {
      const next = new Set(s.setupPending);
      next.add(worktreeId);
      return { setupPending: next };
    });
    try {
      const client = await getWorktreesRpcClient();
      const wt = await Effect.runPromise(
        client.worktree.rerunSetup({ worktreeId }),
      );
      set((s) => {
        const list = s.byProject[projectId] ?? [];
        return {
          byProject: {
            ...s.byProject,
            [projectId]: list.map((existing) =>
              existing.id === wt.id ? wt : existing,
            ),
          },
          setupPending: (() => {
            const next = new Set(s.setupPending);
            next.delete(worktreeId);
            return next;
          })(),
          error: null,
        };
      });
      // Rerun is non-blocking server-side now; follow the fresh run live.
      get().subscribeSetup(projectId, worktreeId);
      return wt;
    } catch (err) {
      set((s) => {
        const next = new Set(s.setupPending);
        next.delete(worktreeId);
        return { setupPending: next, error: formatError(err) };
      });
      return null;
    }
  },
  startRun: async (worktreeId) => {
    try {
      const client = await getWorktreesRpcClient();
      return await Effect.runPromise(client.worktree.startRun({ worktreeId }));
    } catch (err) {
      set({ error: formatError(err) });
      return null;
    }
  },
  subscribeSetup: (projectId, worktreeId) => {
    if (setupFibers.has(worktreeId) || subscribingSetup.has(worktreeId)) return;
    subscribingSetup.add(worktreeId);
    void (async () => {
      try {
        const client = await getWorktreesRpcClient();
        const apply = (event: WorktreeSetupEvent): void => {
          set((s) => {
            const list = s.byProject[projectId];
            if (list === undefined) return s;
            let changed = false;
            const next = list.map((w) => {
              if (w.id !== worktreeId) return w;
              changed = true;
              return event._tag === "chunk"
                ? Worktree.make({ ...w, setupOutput: event.output })
                : Worktree.make({
                    ...w,
                    setupStatus: event.status,
                    setupStartedAt: event.setupStartedAt,
                    setupFinishedAt: event.setupFinishedAt,
                  });
            });
            if (!changed) return s;
            return { byProject: { ...s.byProject, [projectId]: next } };
          });
          if (event._tag === "status" && TERMINAL_SETUP.has(event.status)) {
            const wt = (get().byProject[projectId] ?? []).find(
              (w) => w.id === worktreeId,
            );
            if (wt !== undefined) void maybeAutoRun(projectId, wt);
            flushQueuedForWorktree(worktreeId);
          }
        };
        const fiber = Effect.runFork(
          Stream.runForEach(
            client.worktree
              .setupStream({ worktreeId })
              .pipe(Stream.catchAll(() => Stream.empty)),
            (event) => Effect.sync(() => apply(event)),
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                setupFibers.delete(worktreeId);
              }),
            ),
          ),
        );
        setupFibers.set(worktreeId, fiber);
      } finally {
        subscribingSetup.delete(worktreeId);
      }
    })();
  },
  unsubscribeSetup: (worktreeId) => {
    const fiber = setupFibers.get(worktreeId);
    if (fiber === undefined) return;
    setupFibers.delete(worktreeId);
    void Effect.runPromise(Fiber.interrupt(fiber));
  },
  remove: async (projectId, worktreeId, force) => {
    try {
      const client = await getWorktreesRpcClient();
      await Effect.runPromise(client.worktree.remove({ worktreeId, force }));
      get().unsubscribeSetup(worktreeId);
      set((s) => {
        const list = s.byProject[projectId] ?? [];
        return {
          byProject: {
            ...s.byProject,
            [projectId]: list.filter((w) => w.id !== worktreeId),
          },
          error: null,
        };
      });
      return { ok: true } as const;
    } catch (err) {
      const reason = formatError(err);
      const dirty = !force && isWorktreeDirtyError(err, reason);
      set({ error: dirty ? null : reason });
      return { ok: false, dirty, reason } as const;
    }
  },
}));

export const selectWorktreesFor = (
  projectId: FolderId,
): ReadonlyArray<Worktree> =>
  useWorktreesStore.getState().byProject[projectId] ?? [];
