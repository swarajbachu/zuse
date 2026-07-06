import { create } from "zustand";

import {
  connectEnvironment,
  getEnvironmentStatus,
  listEnvironments,
} from "../rpc/relay-client.ts";
import { useConnectionsStore } from "./connections.ts";

export type Presence = "online" | "offline" | "unknown";

export type DiscoveredEnvironment = {
  environmentId: string;
  label: string;
  presence: Presence;
};

type EnvironmentsState = {
  environments: DiscoveredEnvironment[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Mint a connect token and register the connection; returns its key. */
  connect: (environmentId: string) => Promise<string>;
};

const message = (cause: unknown): string => {
  const text = cause instanceof Error ? cause.message : String(cause);
  if (text.includes("RelayEnvironmentList")) {
    return "Relay returned an older computer list. Refresh after the relay finishes updating.";
  }
  if (text.startsWith("relay_list_")) {
    return "Could not load your computers from the relay.";
  }
  if (text.startsWith("relay_status_")) {
    return "Could not check computer presence.";
  }
  if (text.startsWith("relay_connect_")) {
    return "Could not connect to that computer.";
  }
  return text;
};

export const useEnvironmentsStore = create<EnvironmentsState>((set, get) => ({
  environments: [],
  loading: false,
  error: null,
  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const list = await listEnvironments();
      set({
        environments: list.environments.map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label ?? environment.environmentId,
          presence: "unknown" as const,
        })),
        loading: false,
      });
      // Fan out presence checks; update each as it lands.
      await Promise.all(
        list.environments.map(async (environment) => {
          try {
            const status = await getEnvironmentStatus(environment.environmentId);
            set((state) => ({
              environments: state.environments.map((item) =>
                item.environmentId === environment.environmentId
                  ? { ...item, presence: status.status }
                  : item,
              ),
            }));
          } catch {
            set((state) => ({
              environments: state.environments.map((item) =>
                item.environmentId === environment.environmentId
                  ? { ...item, presence: "offline" as const }
                  : item,
              ),
            }));
          }
        }),
      );
    } catch (cause) {
      set({ loading: false, error: message(cause) });
    }
  },
  connect: async (environmentId) => {
    const grant = await connectEnvironment(environmentId);
    const label =
      get().environments.find((e) => e.environmentId === environmentId)?.label ??
      environmentId;
    const record = await useConnectionsStore.getState().addRelay({
      environmentId,
      label,
      wsBaseUrl: grant.endpoint.wsBaseUrl,
      token: grant.connectToken,
    });
    return record.key;
  },
}));
