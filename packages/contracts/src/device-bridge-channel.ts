import { Schema } from "effect";

/** Independent from remote environment enrollment and RPC credentials. */
export const DEVICE_BRIDGE_CHANNEL_VERSION = 1;
export const DEVICE_BRIDGE_API_PATH = "/v1/device-bridge";
export const BridgeDevice = Schema.Struct({
	deviceId: Schema.String,
	label: Schema.String,
	connected: Schema.Boolean,
	revoked: Schema.Boolean,
	lastSeen: Schema.Number,
});
export type BridgeDevice = typeof BridgeDevice.Type;
export const BridgeDeviceList = Schema.Array(BridgeDevice);
export const BridgeEnrollment = Schema.Struct({
	deviceId: Schema.String,
	label: Schema.String,
	secret: Schema.String,
	restore: Schema.optional(Schema.Boolean),
});
export const BridgeChannelRequest = Schema.Struct({
	type: Schema.Literal("request"),
	id: Schema.String,
	token: Schema.String,
	body: Schema.String,
});
export const BridgeChannelResponse = Schema.Struct({
	type: Schema.Literal("response"),
	id: Schema.String,
	status: Schema.Number,
	body: Schema.String,
});
export const BRIDGE_MAX_MESSAGE_BYTES = 3 * 1024 * 1024;
export const BRIDGE_REQUEST_TIMEOUT_MS = 8000;
