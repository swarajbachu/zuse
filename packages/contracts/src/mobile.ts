import { Rpc } from "effect/unstable/rpc";
import { Schema } from "effect";

export class MobileDevice extends Schema.Class<MobileDevice>("MobileDevice")({
  udid: Schema.String,
  name: Schema.String,
  runtime: Schema.String,
  state: Schema.Literals(["Booted", "Shutdown"]),
  isAvailable: Schema.Boolean,
}) {}

export const MobileProjectType = Schema.Literals([
  "expo",
  "react-native",
  "xcode",
  "none",
]);
export type MobileProjectType = typeof MobileProjectType.Type;

export class MobileProjectDetection extends Schema.Class<MobileProjectDetection>(
  "MobileProjectDetection",
)({
  type: MobileProjectType,
  detail: Schema.optional(Schema.String),
}) {}

export const MobilePhase = Schema.Literals([
  "idle",
  "detecting",
  "booting",
  "building",
  "launching",
  "streaming",
  "error",
]);
export type MobilePhase = typeof MobilePhase.Type;

export class MobileStatus extends Schema.Class<MobileStatus>("MobileStatus")({
  phase: MobilePhase,
  projectType: Schema.optional(MobileProjectDetection),
  device: Schema.optional(MobileDevice),
  error: Schema.optional(Schema.String),
}) {}

export class MobileAvailability extends Schema.Class<MobileAvailability>(
  "MobileAvailability",
)({
  supported: Schema.Boolean,
  reason: Schema.optional(Schema.String),
}) {}

export const MobileEvent = Schema.Union([
  Schema.TaggedStruct("Status", {
    status: MobileStatus,
    source: Schema.Literals(["user", "agent"]),
  }),
  Schema.TaggedStruct("LogChunk", { text: Schema.String }),
  Schema.TaggedStruct("ShutterFlash", {}),
]);
export type MobileEvent = typeof MobileEvent.Type;

export class MobileFrame extends Schema.Class<MobileFrame>("MobileFrame")({
  data: Schema.String,
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
}) {}

export class MobileUnsupportedError extends Schema.TaggedErrorClass<MobileUnsupportedError>()(
  "MobileUnsupportedError",
  { reason: Schema.String },
) {}

export class MobileStartError extends Schema.TaggedErrorClass<MobileStartError>()(
  "MobileStartError",
  {
    phase: MobilePhase,
    reason: Schema.String,
  },
) {}

export class MobileScreenshotError extends Schema.TaggedErrorClass<MobileScreenshotError>()(
  "MobileScreenshotError",
  { reason: Schema.String },
) {}

export const MobileAvailabilityRpc = Rpc.make("mobile.availability", {
  payload: Schema.Struct({}),
  success: MobileAvailability,
});

export const MobileListDevicesRpc = Rpc.make("mobile.listDevices", {
  payload: Schema.Struct({}),
  success: Schema.Array(MobileDevice),
  error: MobileUnsupportedError,
});

export const MobileDetectProjectRpc = Rpc.make("mobile.detectProject", {
  payload: Schema.Struct({ cwd: Schema.String }),
  success: MobileProjectDetection,
});

export const MobileStartRpc = Rpc.make("mobile.start", {
  payload: Schema.Struct({
    cwd: Schema.String,
    udid: Schema.String,
    source: Schema.optional(Schema.Literals(["user", "agent"])),
  }),
  success: Schema.Void,
  error: MobileStartError,
});

export const MobileStopRpc = Rpc.make("mobile.stop", {
  payload: Schema.Struct({}),
  success: Schema.Void,
});

export const MobileStatusRpc = Rpc.make("mobile.status", {
  payload: Schema.Struct({}),
  success: MobileStatus,
});

export const MobileEventsRpc = Rpc.make("mobile.events", {
  payload: Schema.Struct({}),
  success: MobileEvent,
  stream: true,
});

export const MobileFramesRpc = Rpc.make("mobile.frames", {
  payload: Schema.Struct({}),
  success: MobileFrame,
  stream: true,
});
