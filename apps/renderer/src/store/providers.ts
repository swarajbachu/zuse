import { Effect } from "effect";
import { create } from "zustand";

import type { AgentAvailability, ProviderId } from "@zuse/contracts";

import { formatError } from "../lib/format-error.ts";
import { getRpcClient } from "../lib/rpc-client.ts";

// Stable reference for the "no capabilities" case so the `capabilitiesFor`
// selector doesn't return a fresh array each call (which would churn zustand
// subscribers on every unrelated store update).
const EMPTY_CAPABILITIES: ReadonlyArray<string> = [];

export type ProviderUpdateState =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly line: string | null }
  | { readonly kind: "success" }
  | { readonly kind: "failed"; readonly reason: string };

export const IDLE_PROVIDER_UPDATE_STATE: ProviderUpdateState = {
  kind: "idle",
};

/**
 * Renderer-side cache of provider availability + the credentials sheet
 * controller. Replaces the per-session state that used to live in
 * `agents.ts` — sessions now flow through the messages store.
 */
type ProvidersState = {
  readonly availability: ReadonlyArray<AgentAvailability>;
  readonly loading: boolean;
  readonly availabilityLoaded: boolean;
  readonly error: string | null;
  readonly credentialsOpen: boolean;
  readonly updateStateByProvider: Partial<
    Record<ProviderId, ProviderUpdateState>
  >;
  readonly refresh: () => Promise<void>;
  readonly setCredentialsOpen: (open: boolean) => void;
  readonly setProviderUpdateState: (
    providerId: ProviderId,
    state: ProviderUpdateState,
  ) => void;
  /**
   * Version-gated features the installed CLI supports for `providerId` (the
   * `capabilities` list from the availability probe). `[]` when the provider
   * isn't probed yet or declares no gated features. Used to show/hide feature
   * controls (e.g. Codex goal/fast toggles) before a session exists.
   */
  readonly capabilitiesFor: (providerId: ProviderId) => ReadonlyArray<string>;
  readonly setCredential: (
    providerId: ProviderId,
    apiKey: string,
  ) => Promise<void>;
};

export const useProvidersStore = create<ProvidersState>((set, get) => ({
  availability: [],
  loading: false,
  availabilityLoaded: false,
  error: null,
  credentialsOpen: false,
  updateStateByProvider: {},
  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const client = await getRpcClient();
      const list = await Effect.runPromise(client.agent.availability({}));
      set({ availability: list, loading: false, availabilityLoaded: true });
    } catch (err) {
      set({ error: formatError(err), loading: false });
    }
  },
  setCredentialsOpen: (open) => set({ credentialsOpen: open }),
  setProviderUpdateState: (providerId, state) =>
    set((current) => ({
      updateStateByProvider: {
        ...current.updateStateByProvider,
        [providerId]: state,
      },
    })),
  capabilitiesFor: (providerId) =>
    get().availability.find((a) => a.providerId === providerId)?.capabilities ??
    EMPTY_CAPABILITIES,
  setCredential: async (providerId, apiKey) => {
    try {
      const client = await getRpcClient();
      await Effect.runPromise(
        client.agent.setCredential({ providerId, apiKey }),
      );
      await get().refresh();
    } catch (err) {
      set({ error: formatError(err) });
      throw err;
    }
  },
}));
