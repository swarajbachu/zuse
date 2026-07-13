import type { ProviderUsageLimits } from "@zuse/contracts";
import { Effect } from "effect";
import { create } from "zustand";
import { getRpcClient } from "../lib/rpc-client.ts";

let rpcClient = getRpcClient;
export const setUsageLimitsRpcClientForTest = (value: typeof getRpcClient) => {
  rpcClient = value;
};

type State = {
  providers: ReadonlyArray<ProviderUsageLimits>;
  loading: boolean;
  error: string | null;
  lastLoadedAt: number | null;
  load: () => Promise<void>;
  refresh: (
    force?: boolean,
    providerId?: import("@zuse/contracts").ProviderId,
  ) => Promise<void>;
};
export const useUsageLimitsStore = create<State>((set, get) => ({
  providers: [],
  loading: false,
  error: null,
  lastLoadedAt: null,
  load: async () => {
    if (get().lastLoadedAt !== null) return;
    await get().refresh(false);
  },
  refresh: async (force = false, providerId) => {
    set({ loading: true, error: null });
    try {
      const client = await rpcClient();
      const response = await Effect.runPromise(
        client["usage.limits"]({ forceRefresh: force, providerId }),
      );
      set({
        providers: providerId
          ? [
              ...get().providers.filter(
                (item) => item.providerId !== providerId,
              ),
              ...response.providers,
            ]
          : response.providers,
        loading: false,
        lastLoadedAt: Date.now(),
      });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
}));
