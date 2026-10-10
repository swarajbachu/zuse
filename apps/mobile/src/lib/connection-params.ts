import type { WsProtocolOptions } from "~/rpc/ws-protocol";
import type { ConnectionRecord } from "~/store/connections";

export const normalizeConnParam = (
	param: string | string[] | undefined,
): string => (Array.isArray(param) ? (param[0] ?? "") : (param ?? ""));

/** Routes may select visible connections, never manufacture a transport from a URL. */
export const optionsForConnection = (
	key: string,
	connections: ConnectionRecord[],
): WsProtocolOptions | null => {
	const existing = connections.find(
		(connection) => connection.key === key || connection.environmentId === key,
	);
	return existing ?? null;
};
