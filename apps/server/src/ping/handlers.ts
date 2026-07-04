import { MemoizeRpcs, PingResult } from "@zuse/wire";
import { Effect, Layer } from "effect";

/**
 * Phase-1 smoke-test handler. Returns `pong` plus the time the server
 * received the request — proves the RPC pipe is end-to-end wired.
 *
 * Each domain registers handlers per-method via `toLayerHandler` so domains
 * compose without one needing to know about every other RPC in the group.
 */
const PingPing = MemoizeRpcs.toLayerHandler("ping.ping", () =>
  Effect.succeed(PingResult.make({ message: "pong", receivedAt: new Date() })),
);

export const PingHandlersLayer = Layer.mergeAll(PingPing);
