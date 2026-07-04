import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import { Effect } from "effect";

import { connectionKey } from "~/rpc/ws-protocol";

export type ConnectionRecord = {
  key: string;
  host: string;
  port: number;
  token?: string | null;
  label: string;
  updatedAt: number;
};

type ConnectionsState = {
  connections: ConnectionRecord[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  add: (input: { host: string; port: number; token?: string | null }) => Promise<ConnectionRecord>;
  remove: (key: string) => Promise<void>;
};

const STORE_KEY = "zuse.mobile.connections.v1";

const loadConnections = Effect.tryPromise({
  try: async () => {
    const raw = await SecureStore.getItemAsync(STORE_KEY);
    if (raw === null) return [] as ConnectionRecord[];
    return JSON.parse(raw) as ConnectionRecord[];
  },
  catch: () => [] as ConnectionRecord[]
});

const saveConnections = (connections: ConnectionRecord[]) =>
  Effect.tryPromise({
    try: () => SecureStore.setItemAsync(STORE_KEY, JSON.stringify(connections)),
    catch: (cause) => cause
  });

export const useConnectionsStore = create<ConnectionsState>((set, get) => ({
  connections: [],
  hydrated: false,
  hydrate: async () => {
    const connections = await Effect.runPromise(loadConnections);
    set({ connections, hydrated: true });
  },
  add: async ({ host, port, token }) => {
    const key = connectionKey(host, port);
    const record: ConnectionRecord = {
      key,
      host: host.trim(),
      port,
      token: token?.trim() || null,
      label: key,
      updatedAt: Date.now()
    };
    const next = [record, ...get().connections.filter((c) => c.key !== key)];
    set({ connections: next });
    await Effect.runPromise(saveConnections(next));
    return record;
  },
  remove: async (key) => {
    const next = get().connections.filter((c) => c.key !== key);
    set({ connections: next });
    await Effect.runPromise(saveConnections(next));
  }
}));
