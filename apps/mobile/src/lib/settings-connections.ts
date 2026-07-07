import type { ConnectionRecord } from "~/store/connections";

export const advancedConnections = (
  connections: readonly ConnectionRecord[],
): ConnectionRecord[] =>
  connections.filter((connection) => connection.environmentId === undefined);
