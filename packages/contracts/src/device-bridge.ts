import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

/** Additive capability; independent from the desktop RPC wire version. */
export const DEVICE_BRIDGE_VERSION = 1;
export const DeviceCommandDecision = Schema.Literals([
	"AllowOnce",
	"AllowForSession",
	"AlwaysAllow",
	"Deny",
]);
export type DeviceCommandDecision = typeof DeviceCommandDecision.Type;
export const DeviceCommandInput = Schema.Struct({
	id: Schema.String,
	command: Schema.String,
	cwd: Schema.String,
});
export type DeviceCommandInput = typeof DeviceCommandInput.Type;
export const DeviceBridgeAction = Schema.Union([
	Schema.TaggedStruct("status", {}),
	Schema.TaggedStruct("execute", { input: DeviceCommandInput }),
	Schema.TaggedStruct("poll", { id: Schema.String }),
	Schema.TaggedStruct("lease", { id: Schema.String }),
	Schema.TaggedStruct("cancel", { id: Schema.String }),
	Schema.TaggedStruct("decide", {
		id: Schema.String,
		decision: DeviceCommandDecision,
	}),
	Schema.TaggedStruct("revoke", { id: Schema.String }),
]);
export type DeviceBridgeAction = typeof DeviceBridgeAction.Type;
export const DeviceBridgeControl = DeviceBridgeAction;
export type DeviceBridgeControl = typeof DeviceBridgeControl.Type;
export const DeviceCommand = Schema.Struct({
	id: Schema.String,
	accountId: Schema.String,
	workspaceId: Schema.String,
	chatId: Schema.String,
	chatTitle: Schema.String,
	grantEpoch: Schema.Number,
	sessionId: Schema.String,
	deviceId: Schema.String,
	deviceName: Schema.String,
	command: Schema.String,
	cwd: Schema.String,
	state: Schema.Literals([
		"pending",
		"running",
		"completed",
		"denied",
		"cancelled",
		"interrupted",
		"unknown",
	]),
	stdout: Schema.String,
	stderr: Schema.String,
	exitCode: Schema.NullOr(Schema.Number),
	truncated: Schema.Boolean,
	createdAt: Schema.Number,
});
export type DeviceCommand = typeof DeviceCommand.Type;
export const DeviceCommandGrant = Schema.Struct({
	id: Schema.String,
	accountId: Schema.String,
	deviceId: Schema.String,
	chatId: Schema.NullOr(Schema.String),
	grantEpoch: Schema.Number,
	createdAt: Schema.Number,
});
export type DeviceCommandGrant = typeof DeviceCommandGrant.Type;
export const DeviceBridgeStatus = Schema.Struct({
	version: Schema.Literal(DEVICE_BRIDGE_VERSION),
	enabled: Schema.Boolean,
	connected: Schema.Boolean,
	deviceId: Schema.String,
	deviceName: Schema.String,
	homeDirectory: Schema.String,
	commands: Schema.Array(DeviceCommand),
	grants: Schema.Array(DeviceCommandGrant),
});
export type DeviceBridgeStatus = typeof DeviceBridgeStatus.Type;
export const DeviceBridgeResult = Schema.Union([
	DeviceBridgeStatus,
	DeviceCommand,
]);
export type DeviceBridgeResult = typeof DeviceBridgeResult.Type;
export class DeviceBridgeError extends Schema.TaggedErrorClass<DeviceBridgeError>()(
	"DeviceBridgeError",
	{ reason: Schema.String },
) {}
export const DeviceBridgeControlRpc = Rpc.make("deviceBridge.control", {
	payload: DeviceBridgeControl,
	success: DeviceBridgeResult,
	error: DeviceBridgeError,
});
export const CloudDeviceBridgeRpc = Rpc.make("deviceBridge.cloud", {
	payload: Schema.Struct({
		workspaceId: Schema.String,
		action: DeviceBridgeAction,
		targetDeviceId: Schema.optional(Schema.String),
	}),
	success: DeviceBridgeResult,
	error: DeviceBridgeError,
});
