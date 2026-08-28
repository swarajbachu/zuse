export const WORKSPACE_GATEWAY_PROTOCOL = "zuse-workspace-v2" as const;
export const LEGACY_WORKSPACE_GATEWAY_PROTOCOL = "zuse-workspace-v1" as const;

export type WorkspaceGatewayProtocol =
	| typeof WORKSPACE_GATEWAY_PROTOCOL
	| typeof LEGACY_WORKSPACE_GATEWAY_PROTOCOL;

export const workspaceGatewayProtocol = (
	value: string | undefined,
): WorkspaceGatewayProtocol | undefined =>
	value === WORKSPACE_GATEWAY_PROTOCOL ||
	value === LEGACY_WORKSPACE_GATEWAY_PROTOCOL
		? value
		: undefined;

export {
	WORKSPACE_GATEWAY_AUTH_EXPIRED_CLOSE,
	WORKSPACE_GATEWAY_BACKPRESSURE_CLOSE,
	WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE,
	WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE,
	WORKSPACE_GATEWAY_UPDATE_REQUIRED_CLOSE,
} from "@zuse/contracts";

export type WorkspaceGatewayControlMessage =
	| {
			readonly type: "client.open";
			readonly connectionId: string;
	  }
	| {
			readonly type: "client.close";
			readonly connectionId: string;
	  };

export const encodeGatewayMessage = (
	message: WorkspaceGatewayControlMessage,
): string => JSON.stringify(message);

export const decodeGatewayMessage = (
	value: string,
): WorkspaceGatewayControlMessage | null => {
	let candidate: unknown;
	try {
		candidate = JSON.parse(value);
	} catch {
		return null;
	}
	if (candidate === null || typeof candidate !== "object") return null;
	const record = candidate as Record<string, unknown>;
	if (typeof record.type !== "string") return null;
	switch (record.type) {
		case "client.open":
		case "client.close":
			return typeof record.connectionId === "string"
				? (record as WorkspaceGatewayControlMessage)
				: null;
		default:
			return null;
	}
};
