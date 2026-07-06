import type { ConnectionRecord } from "~/store/connections";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

export const normalizeConnParam = (param: string | string[] | undefined): string =>
  Array.isArray(param) ? param[0] ?? "" : param ?? "";

export const parseConnectionKey = (key: string): WsProtocolOptions => {
  const [host = "127.0.0.1", port = "8787"] = key.split(":");
  return { host, port: Number(port) || 8787 };
};

export const optionsForConnection = (
  key: string,
  connections: ConnectionRecord[]
): WsProtocolOptions => {
  const existing = connections.find(
    (connection) =>
      connection.key === key || connection.environmentId === key
  );
  return existing ?? parseConnectionKey(key);
};
