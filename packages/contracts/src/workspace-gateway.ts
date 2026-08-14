const FRAME_MAGIC = [0x5a, 0x55, 0x53, 0x45] as const; // "ZUSE"
const FRAME_VERSION = 1;
const FRAME_HEADER_BYTES = 9;
const MAX_CONNECTION_ID_BYTES = 512;
export const MAX_WORKSPACE_GATEWAY_PAYLOAD_BYTES = 8 * 1_024 * 1_024;

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

export type WorkspaceGatewayFrameDirection = "client" | "runtime";

export type WorkspaceGatewayFrame = Readonly<{
	direction: WorkspaceGatewayFrameDirection;
	connectionId: string;
	payload: string | ArrayBuffer;
}>;

const directionByte = (direction: WorkspaceGatewayFrameDirection): number =>
	direction === "client" ? 1 : 2;

const payloadBytes = (
	payload: string | ArrayBuffer,
): Readonly<{ encoding: number; bytes: Uint8Array }> =>
	typeof payload === "string"
		? { encoding: 1, bytes: new TextEncoder().encode(payload) }
		: { encoding: 2, bytes: new Uint8Array(payload) };

const exactBuffer = (bytes: Uint8Array): ArrayBuffer => {
	const output = new Uint8Array(bytes.byteLength);
	output.set(bytes);
	return output.buffer;
};

/**
 * Multiplexes one opaque RPC payload over the runtime's single gateway socket.
 * The gateway reads only this small routing envelope; payload bytes are copied
 * without JSON or base64 expansion.
 */
export const encodeWorkspaceGatewayFrame = (
	frame: WorkspaceGatewayFrame,
): ArrayBuffer => {
	const connectionId = new TextEncoder().encode(frame.connectionId);
	if (
		connectionId.byteLength === 0 ||
		connectionId.byteLength > MAX_CONNECTION_ID_BYTES
	) {
		throw new RangeError("Invalid workspace gateway connection ID");
	}
	const payload = payloadBytes(frame.payload);
	if (payload.bytes.byteLength > MAX_WORKSPACE_GATEWAY_PAYLOAD_BYTES) {
		throw new RangeError("Workspace gateway payload is too large");
	}
	const output = new Uint8Array(
		FRAME_HEADER_BYTES + connectionId.byteLength + payload.bytes.byteLength,
	);
	output.set(FRAME_MAGIC, 0);
	output[4] = FRAME_VERSION;
	output[5] = directionByte(frame.direction);
	output[6] = payload.encoding;
	new DataView(output.buffer).setUint16(7, connectionId.byteLength, false);
	output.set(connectionId, FRAME_HEADER_BYTES);
	output.set(payload.bytes, FRAME_HEADER_BYTES + connectionId.byteLength);
	return output.buffer;
};

/** Returns null for malformed, unsupported, or non-gateway binary frames. */
export const decodeWorkspaceGatewayFrame = (
	value: ArrayBuffer,
): WorkspaceGatewayFrame | null => {
	const bytes = new Uint8Array(value);
	if (
		bytes.byteLength < FRAME_HEADER_BYTES ||
		FRAME_MAGIC.some((byte, index) => bytes[index] !== byte) ||
		bytes[4] !== FRAME_VERSION
	) {
		return null;
	}
	const direction =
		bytes[5] === 1 ? "client" : bytes[5] === 2 ? "runtime" : null;
	const encoding = bytes[6];
	if (direction === null || (encoding !== 1 && encoding !== 2)) return null;
	const connectionIdLength = new DataView(value).getUint16(7, false);
	if (
		connectionIdLength === 0 ||
		connectionIdLength > MAX_CONNECTION_ID_BYTES ||
		FRAME_HEADER_BYTES + connectionIdLength > bytes.byteLength ||
		bytes.byteLength - FRAME_HEADER_BYTES - connectionIdLength >
			MAX_WORKSPACE_GATEWAY_PAYLOAD_BYTES
	) {
		return null;
	}
	try {
		const connectionId = new TextDecoder("utf-8", { fatal: true }).decode(
			bytes.subarray(
				FRAME_HEADER_BYTES,
				FRAME_HEADER_BYTES + connectionIdLength,
			),
		);
		if (connectionId.length === 0) return null;
		const body = bytes.slice(FRAME_HEADER_BYTES + connectionIdLength);
		return {
			direction,
			connectionId,
			payload:
				encoding === 1
					? new TextDecoder("utf-8", { fatal: true }).decode(body)
					: exactBuffer(body),
		};
	} catch {
		return null;
	}
};

/** Converts binary payload views from browser/Node WebSocket implementations. */
export const workspaceGatewayArrayBuffer = (
	value: ArrayBuffer | ArrayBufferView,
): ArrayBuffer => {
	if (value instanceof ArrayBuffer) return value;
	return exactBuffer(
		new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
	);
};
