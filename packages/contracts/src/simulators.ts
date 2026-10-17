import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { ChatId } from "./ids.ts";

/** An iOS UDID, an Android AVD name, or a running emulator's serial. */
export const SimulatorId = Schema.String.check(
	Schema.isPattern(/^[A-Za-z0-9._-]{1,128}$/u),
);
export const SimulatorPlatform = Schema.Literals(["ios", "android"]);
export type SimulatorPlatform = typeof SimulatorPlatform.Type;
export const SimulatorSummary = Schema.Struct({
	id: SimulatorId,
	platform: SimulatorPlatform,
	name: Schema.String,
	version: Schema.String,
	booted: Schema.Boolean,
});
export type SimulatorSummary = typeof SimulatorSummary.Type;
export const SimulatorSession = Schema.Struct({
	chatId: ChatId,
	deviceId: SimulatorId,
	openedAt: Schema.Number,
});
export type SimulatorSession = typeof SimulatorSession.Type;
/** Host prerequisites, checked read-only before anything is installed. */
export const SimulatorRequirementId = Schema.Literals([
	"xcode",
	"runtime",
	"android-sdk",
	"android-avd",
	"node",
]);
export const SimulatorRequirement = Schema.Struct({
	id: SimulatorRequirementId,
	/** `all` requirements apply to both platforms. */
	platform: Schema.Literals(["ios", "android", "all"]),
	ok: Schema.Boolean,
	detail: Schema.String,
	/** One-click remedy the host can perform; `running` while it is in progress. */
	fix: Schema.optional(
		Schema.Struct({ label: Schema.String, running: Schema.Boolean }),
	),
});
export type SimulatorRequirement = typeof SimulatorRequirement.Type;
export const SimulatorState = Schema.Struct({
	enabled: Schema.Boolean,
	agentAccessEnabled: Schema.Boolean,
	onboardingCompleted: Schema.Boolean,
	/** `idle`: enabled, but helpers start only when a viewer or agent needs them. */
	status: Schema.Literals([
		"disabled",
		"idle",
		"checking",
		"installing",
		"starting",
		"ready",
		"unavailable",
		"error",
	]),
	detail: Schema.String,
	/** Empty until the host has been checked. */
	requirements: Schema.Array(SimulatorRequirement),
	agentStatus: Schema.Literals(["off", "installing", "ready", "error"]),
	agentDetail: Schema.String,
	/** Pinned helper versions installed on demand by this environment. */
	tools: Schema.Struct({ hub: Schema.String, agent: Schema.String }),
	devices: Schema.Array(SimulatorSummary),
	sessions: Schema.Array(SimulatorSession),
	revision: Schema.Number,
});
export type SimulatorState = typeof SimulatorState.Type;
export class SimulatorError extends Schema.TaggedErrorClass<SimulatorError>()(
	"SimulatorError",
	{ reason: Schema.String },
) {}
export const SimulatorTarget = Schema.Struct({
	chatId: ChatId,
	deviceId: SimulatorId,
});
export type SimulatorTarget = typeof SimulatorTarget.Type;
export const SimulatorInput = Schema.Union([
	Schema.TaggedStruct("touch", {
		phase: Schema.Literals(["begin", "move", "end"]),
		x: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
		y: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
	}),
	Schema.TaggedStruct("key", {
		phase: Schema.Literals(["down", "up"]),
		usage: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
	}),
	Schema.TaggedStruct("button", {
		button: Schema.Literals(["home", "app_switcher", "lock", "back"]),
	}),
	/** Android text entry; iOS keyboards use HID `key` events instead. */
	Schema.TaggedStruct("text", {
		text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
	}),
	/** Android key event for keys without text, such as arrows and Backspace. */
	Schema.TaggedStruct("keycode", {
		keycode: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 400 })),
	}),
	Schema.TaggedStruct("rotate", {
		orientation: Schema.Literals([
			"portrait",
			"landscape_left",
			"landscape_right",
			"portrait_upside_down",
		]),
	}),
]);
export type SimulatorInput = typeof SimulatorInput.Type;
/**
 * Video packets. iOS: 1 avcC description, 2 AVCC keyframe, 3 AVCC delta,
 * 4 JPEG, 130 screen config. Android: 16 Annex-B keyframe, 17 Annex-B delta,
 * 18 encoder restarted (reset the decoder and wait for a keyframe).
 */
export const SimulatorPacket = Schema.Struct({
	tag: Schema.Int,
	data: Schema.String,
});
export type SimulatorPacket = typeof SimulatorPacket.Type;
export const SimulatorStateRpc = Rpc.make("simulators.state", {
	payload: Schema.Struct({}),
	success: SimulatorState,
	stream: true,
});
export const SimulatorRefreshRpc = Rpc.make("simulators.refresh", {
	payload: Schema.Struct({}),
	success: SimulatorState,
	error: SimulatorError,
});
export const SimulatorConfigureRpc = Rpc.make("simulators.configure", {
	payload: Schema.Struct({
		enabled: Schema.optional(Schema.Boolean),
		agentAccessEnabled: Schema.optional(Schema.Boolean),
		onboardingCompleted: Schema.optional(Schema.Boolean),
	}),
	success: SimulatorState,
	error: SimulatorError,
});
export const SimulatorFixRpc = Rpc.make("simulators.fix", {
	payload: Schema.Struct({ requirement: SimulatorRequirementId }),
	success: SimulatorState,
	error: SimulatorError,
});
export const SimulatorOpenRpc = Rpc.make("simulators.open", {
	payload: SimulatorTarget,
	success: SimulatorSummary,
	error: SimulatorError,
});
export const SimulatorCloseRpc = Rpc.make("simulators.close", {
	payload: Schema.Struct({
		...SimulatorTarget.fields,
		shutdown: Schema.optional(Schema.Boolean),
	}),
	success: Schema.Void,
	error: SimulatorError,
});
export const SimulatorFramesRpc = Rpc.make("simulators.frames", {
	payload: Schema.Struct({
		...SimulatorTarget.fields,
		format: Schema.Literals(["avcc", "mjpeg"]),
	}),
	success: SimulatorPacket,
	stream: true,
	error: SimulatorError,
});
export const SimulatorInputRpc = Rpc.make("simulators.input", {
	payload: Schema.Struct({ ...SimulatorTarget.fields, input: SimulatorInput }),
	success: Schema.Void,
	error: SimulatorError,
});
export const SimulatorScreenshotRpc = Rpc.make("simulators.screenshot", {
	payload: SimulatorTarget,
	success: Schema.String,
	error: SimulatorError,
});
