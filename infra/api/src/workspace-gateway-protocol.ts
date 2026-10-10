export const WORKSPACE_GATEWAY_PROTOCOL = "zuse-workspace-v2" as const;
export const LEGACY_WORKSPACE_GATEWAY_PROTOCOL = "zuse-workspace-v1" as const;

export type WorkspaceGatewayProtocol =
	| typeof WORKSPACE_GATEWAY_PROTOCOL
	| typeof WORKSPACE_GATEWAY_PENDING_PROTOCOL
	| typeof LEGACY_WORKSPACE_GATEWAY_PROTOCOL;

/** Only the API's verified response may supply internal gateway authority. */
export const gatewayForwardHeaders = (
	request: Headers,
	verified: Headers,
): Headers => {
	const headers = new Headers(request);
	headers.delete("authorization");
	request.forEach((_value, key) => {
		if (key.startsWith("x-zuse-gateway-")) headers.delete(key);
	});
	for (const field of [
		"workspace",
		"role",
		"generation",
		"epoch",
		"protocol",
		"connection",
		"actor",
		"permission",
	]) {
		const key = `x-zuse-gateway-${field}`;
		const value = verified.get(key);
		if (value !== null) headers.set(key, value);
	}
	return headers;
};

export const workspaceGatewayProtocol = (
	value: string | undefined,
): WorkspaceGatewayProtocol | undefined =>
	value === WORKSPACE_GATEWAY_PROTOCOL ||
	value === WORKSPACE_GATEWAY_PENDING_PROTOCOL ||
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
			/** Established by API ticket verification, not client request headers. */
			readonly actorId?: string;
			readonly permission?: "view" | "edit";
	  }
	| {
			readonly type: "client.close";
			readonly connectionId: string;
	  }
	| {
			/**
			 * API → runtime only: pending public-API commands are waiting; the
			 * runtime should drain `GET …/runtime/commands`. Deliberately absent
			 * from `decodeGatewayMessage` so peers cannot inject it upward.
			 */
			readonly type: "runtime.command";
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

import { WORKSPACE_GATEWAY_PENDING_PROTOCOL } from "@zuse/contracts";

export { WORKSPACE_GATEWAY_PENDING_PROTOCOL } from "@zuse/contracts";
