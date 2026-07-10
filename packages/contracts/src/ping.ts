import { Rpc } from "effect/unstable/rpc";
import { Schema } from "effect";

export class PingResult extends Schema.Class<PingResult>("PingResult")({
  message: Schema.Literal("pong"),
  receivedAt: Schema.DateFromString,
}) {}

export class PingError extends Schema.TaggedErrorClass<PingError>()("PingError", {
  message: Schema.String,
}) {}

export const PingRpc = Rpc.make("ping.ping", {
  payload: Schema.Struct({}),
  success: PingResult,
  error: PingError,
});
