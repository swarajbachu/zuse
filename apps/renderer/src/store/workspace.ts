import { Effect } from "effect";
import { create } from "zustand";

import type {
  Folder,
  FolderId,
  GithubRepoSummary,
  ProjectTemplate,
} from "@zuse/wire";

import { getRpcClient } from "../lib/rpc-client.ts";

type WorkspaceState = {
  folders: ReadonlyArray<Folder>;
  selectedFolderId: FolderId | null;
  loading: boolean;
  error: string | null;
  /**
   * Recent GitHub repos surfaced from `gh repo list`, used by the Clone
   * dialog. `null` = "haven't fetched yet", `[]` = "fetched and empty
   * (or gh missing)" so the dialog can show the right hint.
   */
  recentGithubRepos: ReadonlyArray<GithubRepoSummary> | null;
  /** Loading flag so the Clone dialog can render a spinner under recents. */
  recentGithubReposLoading: boolean;
  /** Cached gh auth result — `null` until probed. */
  ghAuthenticated: boolean | null;
  load: () => Promise<void>;
  add: () => Promise<void>;
  remove: (folderId: FolderId) => Promise<void>;
  select: (folderId: FolderId) => Promise<void>;
  /**
   * Ask the host for an OS folder picker. Returns the absolute path the
   * user chose, or `null` if they cancelled. Used by the Clone /
   * Quick-start dialogs to populate their Location/Parent fields.
   */
  pickFolder: () => Promise<string | null>;
  /** Refresh the recents + auth probes; safe to call repeatedly. */
  loadGithubContext: () => Promise<void>;
  /**
   * Clone `url` into `<parent>/<derived-name>`. Returns the new Folder
   * on success, throws (rejects) on failure so the dialog can render
   * the error inline.
   */
  cloneRepo: (url: string, parent: string) => Promise<Folder>;
  /**
   * Scaffold a new project and register it. Throws on failure so the
   * dialog can render `WorkspaceCreateFailedError.reason`.
   */
  createProject: (params: {
    name: string;
    parent: string;
    template: ProjectTemplate;
    alsoCreateGithubRepo: boolean;
  }) => Promise<Folder>;
};

const persistSelection = async (folderId: FolderId | null): Promise<void> => {
  try {
    const client = await getRpcClient();
    await Effect.runPromise(client.workspace.setSelected({ folderId }));
  } catch {
    // best-effort persistence; the in-memory store already updated
  }
};

const formatError = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    // TaggedErrors travel over RPC carrying `_tag` plus their schema
    // fields. Prefer the human-readable ones over the bare tag — the
    // dialog inline-renders this string verbatim.
    const obj = err as Record<string, unknown>;
    if (typeof obj.reason === "string" && obj.reason.length > 0) {
      return obj.reason;
    }
    if (typeof obj._tag === "string") return obj._tag;
  }
  return String(err);
};

/**
 * Throwing variant used by the Clone / Quick-start flows — the calling
 * dialog catches this and renders the message inline. The plain `add()`
 * action keeps swallowing-and-storing because the sidebar's `+` button
 * has no surface for inline errors.
 */
const rethrow = (err: unknown): never => {
  throw new Error(formatError(err));
};

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  folders: [],
  selectedFolderId: null,
  loading: false,
  error: null,
  recentGithubRepos: null,
  recentGithubReposLoading: false,
  ghAuthenticated: null,
  load: async () => {
    set({ loading: true, error: null });
    try {
      const client = await getRpcClient();
      const [folders, persisted] = await Promise.all([
        Effect.runPromise(client.workspace.list({})),
        Effect.runPromise(client.workspace.getSelected({})),
      ]);
      // Prefer the persisted selection if its folder still exists; otherwise
      // pick the first folder so the UI is never in a "have folders, none
      // selected" limbo on cold start.
      const selected =
        persisted !== null && folders.some((f) => f.id === persisted)
          ? persisted
          : (folders[0]?.id ?? null);
      set({ folders, selectedFolderId: selected, loading: false });
      // If we fell back to first-folder, persist that so the next launch
      // restores the same one without re-running the fallback.
      if (selected !== persisted) await persistSelection(selected);
    } catch (err) {
      set({ error: formatError(err), loading: false });
    }
  },
  add: async () => {
    set({ error: null });
    try {
      const client = await getRpcClient();
      const path = await Effect.runPromise(client.workspace.pickFolder({}));
      if (path === null) return;
      const folder = await Effect.runPromise(client.workspace.add({ path }));
      set((s) => ({
        folders: [...s.folders, folder],
        selectedFolderId: folder.id,
      }));
      await persistSelection(folder.id);
    } catch (err) {
      set({ error: formatError(err) });
    }
  },
  remove: async (folderId) => {
    set({ error: null });
    try {
      const client = await getRpcClient();
      await Effect.runPromise(client.workspace.remove({ folderId }));
      const nextSelected = (() => {
        const s = get();
        const folders = s.folders.filter((f) => f.id !== folderId);
        const selectedFolderId =
          s.selectedFolderId === folderId
            ? (folders[0]?.id ?? null)
            : s.selectedFolderId;
        set({ folders, selectedFolderId });
        return { selectedFolderId, changed: s.selectedFolderId === folderId };
      })();
      if (nextSelected.changed) await persistSelection(nextSelected.selectedFolderId);
    } catch (err) {
      set({ error: formatError(err) });
    }
  },
  select: async (folderId) => {
    if (get().selectedFolderId === folderId) return;
    set({ selectedFolderId: folderId });
    await persistSelection(folderId);
  },
  pickFolder: async () => {
    try {
      const client = await getRpcClient();
      return await Effect.runPromise(client.workspace.pickFolder({}));
    } catch {
      return null;
    }
  },
  loadGithubContext: async () => {
    // Mark the recents list as in-flight so the dialog doesn't flash
    // "no repos" while we're still fetching the first time.
    set({ recentGithubReposLoading: true });
    try {
      const client = await getRpcClient();
      const [repos, auth] = await Promise.all([
        Effect.runPromise(client.workspace.listGithubRepos({ limit: 30 })),
        Effect.runPromise(client.workspace.ghAuthStatus({})),
      ]);
      set({
        recentGithubRepos: repos,
        ghAuthenticated: auth.authenticated,
        recentGithubReposLoading: false,
      });
    } catch {
      set({
        recentGithubRepos: [],
        ghAuthenticated: false,
        recentGithubReposLoading: false,
      });
    }
  },
  cloneRepo: async (url, parent) => {
    set({ error: null });
    try {
      const client = await getRpcClient();
      const folder = await Effect.runPromise(
        client.workspace.cloneRepo({ url, parent }),
      );
      set((s) => ({
        folders: [...s.folders, folder],
        selectedFolderId: folder.id,
      }));
      await persistSelection(folder.id);
      return folder;
    } catch (err) {
      return rethrow(err);
    }
  },
  createProject: async ({ name, parent, template, alsoCreateGithubRepo }) => {
    set({ error: null });
    try {
      const client = await getRpcClient();
      const folder = await Effect.runPromise(
        client.workspace.createProject({
          name,
          parent,
          template,
          alsoCreateGithubRepo,
        }),
      );
      set((s) => ({
        folders: [...s.folders, folder],
        selectedFolderId: folder.id,
      }));
      await persistSelection(folder.id);
      return folder;
    } catch (err) {
      return rethrow(err);
    }
  },
}));
