import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import { Effect } from "effect";

import { getConnectionClient } from "~/rpc/connection";
import { connectionKey } from "~/rpc/ws-protocol";

export type ConnectionRecord = {
  key: string;
  environmentId?: string;
  host: string;
  port: number;
  token?: string | null;
  /** Full ws(s):// base URL for relay/tunnel-reached environments. */
  wsBaseUrl?: string | null;
  label: string;
  updatedAt: number;
};

type ConnectionsState = {
  connections: ConnectionRecord[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  add: (input: {
    host: string;
    port: number;
    token?: string | null;
  }) => Promise<ConnectionRecord>;
  /** Upsert a relay-discovered environment reached via a managed endpoint. */
  addRelay: (input: {
    environmentId: string;
    label: string;
    wsBaseUrl: string;
    token: string;
  }) => Promise<ConnectionRecord>;
  remove: (key: string) => Promise<void>;
};

const parseHostPort = (wsBaseUrl: string): { host: string; port: number } => {
  try {
    const url = new URL(wsBaseUrl);
    return {
      host: url.hostname,
      port: Number(url.port) || (url.protocol === "wss:" ? 443 : 80),
    };
  } catch {
    return { host: "127.0.0.1", port: 8787 };
  }
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
    const trimmedHost = host.trim();
    const redeemed = await redeemPairingCodeIfNeeded({
      host: trimmedHost,
      port,
      token
    });
    const descriptor = await describeEnvironment({
      host: trimmedHost,
      port,
      token: redeemed
    });
    const key = descriptor?.environmentId ?? connectionKey(trimmedHost, port);
    const record: ConnectionRecord = {
      key,
      environmentId: descriptor?.environmentId,
      host: trimmedHost,
      port,
      token: redeemed,
      label: descriptor?.label ?? descriptor?.environmentId ?? key,
      updatedAt: Date.now()
    };
    const next = [record, ...get().connections.filter((c) => c.key !== key)];
    set({ connections: next });
    await Effect.runPromise(saveConnections(next));
    return record;
  },
  addRelay: async ({ environmentId, label, wsBaseUrl, token }) => {
    const { host, port } = parseHostPort(wsBaseUrl);
    const record: ConnectionRecord = {
      key: environmentId,
      environmentId,
      host,
      port,
      wsBaseUrl,
      token,
      label,
      updatedAt: Date.now(),
    };
    const next = [
      record,
      ...get().connections.filter((c) => c.key !== environmentId),
    ];
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

const redeemPairingCodeIfNeeded = async ({
  host,
  port,
  token
}: {
  host: string;
  port: number;
  token?: string | null;
}): Promise<string | null> => {
  const trimmed = token?.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("zp_")) return trimmed;

  const response = await fetch(`http://${host}:${port}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: trimmed })
  });
  if (!response.ok) {
    throw new Error(`Pairing failed (${response.status})`);
  }
  const body = (await response.json()) as { token?: string };
  if (typeof body.token !== "string" || !body.token.startsWith("zt_")) {
    throw new Error("Pairing response did not include a bearer token");
  }
  return body.token;
};

const describeEnvironment = async (options: {
  host: string;
  port: number;
  token: string | null;
}) => {
  try {
    const client = await Effect.runPromise(getConnectionClient(options));
    return await Effect.runPromise(client.connect.describe());
  } catch {
    return null;
  }
};
