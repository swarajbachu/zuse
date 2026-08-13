export const WORKSPACE_GATEWAY_PROTOCOL = "zuse-workspace-v2" as const;

export const WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE = {
	code: 4100,
	reason: "workspace runtime unavailable",
} as const;

export const WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE = {
	code: 4101,
	reason: "workspace generation changed",
} as const;

export const WORKSPACE_GATEWAY_AUTH_EXPIRED_CLOSE = {
	code: 4102,
	reason: "workspace authorization expired",
} as const;

export const WORKSPACE_GATEWAY_UPDATE_REQUIRED_CLOSE = {
	code: 4103,
	reason: "client update required",
} as const;

export const WORKSPACE_GATEWAY_BACKPRESSURE_CLOSE = {
	code: 4104,
	reason: "workspace gateway backpressure",
} as const;

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
