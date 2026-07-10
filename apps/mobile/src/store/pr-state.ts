import type { FolderId, GitPrInfo, WorktreeId } from "@zuse/contracts";
import { Effect } from "effect";
import { create } from "zustand";

import { getConnectionClient, reportConnectionFailure } from "~/rpc/connection";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

export const prStateKey = (
  connKey: string,
  folderId: FolderId,
  worktreeId: WorktreeId | null,
): string => `${connKey}:${folderId}:${worktreeId ?? "main"}`;

type PrStateStore = {
  byKey: Record<string, GitPrInfo | null>;
  loadingByKey: Record<string, boolean>;
  hydrate: (
    connKey: string,
    options: WsProtocolOptions,
    folderId: FolderId,
    worktreeId: WorktreeId | null,
  ) => Promise<void>;
};

export const usePrStateStore = create<PrStateStore>((set, get) => ({
  byKey: {},
  loadingByKey: {},
  hydrate: async (connKey, options, folderId, worktreeId) => {
    const key = prStateKey(connKey, folderId, worktreeId);
    if (get().byKey[key] !== undefined || get().loadingByKey[key]) return;

    set((state) => ({
      loadingByKey: { ...state.loadingByKey, [key]: true },
    }));

    try {
      const client = await Effect.runPromise(getConnectionClient(options));
      const info = await Effect.runPromise(
        client["git.prState"]({ folderId, worktreeId }),
      );
      set((state) => ({
        byKey: { ...state.byKey, [key]: info },
        loadingByKey: { ...state.loadingByKey, [key]: false },
      }));
    } catch (cause) {
      reportConnectionFailure(options, cause);
      set((state) => ({
        byKey: { ...state.byKey, [key]: null },
        loadingByKey: { ...state.loadingByKey, [key]: false },
      }));
    }
  },
}));
