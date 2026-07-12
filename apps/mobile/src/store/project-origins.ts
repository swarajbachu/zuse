import type { FolderId, GitOriginInfo } from "@zuse/contracts";
import { Effect } from "effect";
import { create } from "zustand";

import { getConnectionClient, reportConnectionFailure } from "~/rpc/connection";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

export const projectOriginKey = (connKey: string, folderId: FolderId): string =>
  `${connKey}:${folderId}`;

type ProjectOriginStore = {
  byKey: Record<string, GitOriginInfo | null>;
  loadingByKey: Record<string, boolean>;
  hydrate: (
    connKey: string,
    options: WsProtocolOptions,
    folderId: FolderId,
  ) => Promise<void>;
};

export const useProjectOriginStore = create<ProjectOriginStore>((set, get) => ({
  byKey: {},
  loadingByKey: {},
  hydrate: async (connKey, options, folderId) => {
    const key = projectOriginKey(connKey, folderId);
    if (get().byKey[key] !== undefined || get().loadingByKey[key]) return;

    set((state) => ({
      loadingByKey: { ...state.loadingByKey, [key]: true },
    }));

    try {
      const client = await Effect.runPromise(getConnectionClient(options));
      const origin = await Effect.runPromise(client["git.origin"]({ folderId }));
      set((state) => ({
        byKey: { ...state.byKey, [key]: origin },
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
