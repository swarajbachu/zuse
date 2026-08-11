export const WORKSPACE_GATEWAY_PROTOCOL = "zuse-workspace-v1" as const;

export type WorkspaceGatewayControlMessage =
	| {
			readonly type: "runtime.connected";
			readonly workspaceId: string;
	  }
	| {
			readonly type: "runtime.disconnected";
			readonly workspaceId: string;
	  }
	| {
			readonly type: "client.open";
			readonly connectionId: string;
	  }
	| {
			readonly type: "client.close";
			readonly connectionId: string;
	  }
	| {
			readonly type: "client.frame";
			readonly connectionId: string;
			readonly encoding: "text" | "base64";
			readonly payload: string;
	  }
	| {
			readonly type: "runtime.frame";
			readonly connectionId: string;
			readonly encoding: "text" | "base64";
			readonly payload: string;
	  }
	| {
			readonly type: "command.available";
			readonly throughSequence: number;
	  }
	| {
			readonly type: "event.available";
			readonly throughSequence: number;
	  }
	| {
			readonly type: "workspace.status";
			readonly phase: string;
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
		case "runtime.connected":
		case "runtime.disconnected":
			return typeof record.workspaceId === "string"
				? (record as WorkspaceGatewayControlMessage)
				: null;
		case "client.open":
		case "client.close":
			return typeof record.connectionId === "string"
				? (record as WorkspaceGatewayControlMessage)
				: null;
		case "client.frame":
		case "runtime.frame":
			return typeof record.connectionId === "string" &&
				(record.encoding === "text" || record.encoding === "base64") &&
				typeof record.payload === "string"
				? (record as WorkspaceGatewayControlMessage)
				: null;
		case "command.available":
		case "event.available":
			return typeof record.throughSequence === "number" &&
				Number.isSafeInteger(record.throughSequence) &&
				record.throughSequence >= 0
				? (record as WorkspaceGatewayControlMessage)
				: null;
		case "workspace.status":
			return typeof record.phase === "string"
				? (record as WorkspaceGatewayControlMessage)
				: null;
		default:
			return null;
	}
};

export const encodeGatewayFrame = (
	value: string | ArrayBuffer,
): { readonly encoding: "text" | "base64"; readonly payload: string } =>
	typeof value === "string"
		? { encoding: "text", payload: value }
		: {
				encoding: "base64",
				payload: Buffer.from(value).toString("base64"),
			};

export const decodeGatewayFrame = (input: {
	readonly encoding: "text" | "base64";
	readonly payload: string;
}): string | ArrayBuffer =>
	input.encoding === "text"
		? input.payload
		: Uint8Array.from(Buffer.from(input.payload, "base64")).buffer;
