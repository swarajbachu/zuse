import type { AgentAvailability } from "@zuse/contracts";
import { Effect } from "effect";
import { create } from "zustand";

import { fetchAgentAvailability } from "~/rpc/actions";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

type AvailabilityStore = {
  /**
   * Per-connection availability report. `undefined` = never fetched, `null` =
   * fetched but the server doesn't support the RPC (old desktop) — callers
   * treat `null` as "no filtering, show the full catalog".
   */
  availabilityByConnection: Record<
    string,
    readonly AgentAvailability[] | null | undefined
  >;
  loadingByConnection: Record<string, boolean>;
  hydrate: (connKey: string, options: WsProtocolOptions) => Promise<void>;
  /** Drop the cached report so the next hydrate re-fetches (reconnect, etc.). */
  invalidate: (connKey: string) => void;
};

export const useAvailabilityStore = create<AvailabilityStore>((set, get) => ({
  availabilityByConnection: {},
  loadingByConnection: {},
  hydrate: async (connKey, options) => {
    if (
      get().availabilityByConnection[connKey] !== undefined ||
      get().loadingByConnection[connKey]
    ) {
      return;
    }
    set((state) => ({
      loadingByConnection: { ...state.loadingByConnection, [connKey]: true },
    }));
    const result = await Effect.runPromise(
      fetchAgentAvailability({ connection: options }),
    );
    set((state) => ({
      availabilityByConnection: {
        ...state.availabilityByConnection,
        [connKey]: result,
      },
      loadingByConnection: { ...state.loadingByConnection, [connKey]: false },
    }));
  },
  invalidate: (connKey) =>
    set((state) => {
      if (state.availabilityByConnection[connKey] === undefined) return state;
      const next = { ...state.availabilityByConnection };
      delete next[connKey];
      return { availabilityByConnection: next };
    }),
}));
