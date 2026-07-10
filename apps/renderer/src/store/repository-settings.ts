import { Effect } from "effect";
import { create } from "zustand";

import type {
  FolderId,
  RepositorySettings,
  RepositorySettingsPatch,
} from "@zuse/contracts";

import { getRpcClient } from "../lib/rpc-client.ts";

type RepoSettingsState = {
  readonly byProject: Readonly<Record<string, RepositorySettings>>;
  readonly error: string | null;
  readonly refresh: (projectId: FolderId) => Promise<RepositorySettings | null>;
  readonly update: (
    projectId: FolderId,
    patch: RepositorySettingsPatch,
  ) => Promise<RepositorySettings | null>;
};

const formatError = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "_tag" in err) {
    return String((err as { _tag: unknown })._tag);
  }
  return String(err);
};

export const useRepositorySettingsStore = create<RepoSettingsState>((set) => ({
  byProject: {},
  error: null,
  refresh: async (projectId) => {
    try {
      const client = await getRpcClient();
      const settings = await Effect.runPromise(
        client.repositorySettings.get({ projectId }),
      );
      set((s) => ({
        byProject: { ...s.byProject, [projectId]: settings },
        error: null,
      }));
      return settings;
    } catch (err) {
      set({ error: formatError(err) });
      return null;
    }
  },
  update: async (projectId, patch) => {
    try {
      const client = await getRpcClient();
      const settings = await Effect.runPromise(
        client.repositorySettings.update({ projectId, patch }),
      );
      set((s) => ({
        byProject: { ...s.byProject, [projectId]: settings },
        error: null,
      }));
      return settings;
    } catch (err) {
      set({ error: formatError(err) });
      return null;
    }
  },
}));
