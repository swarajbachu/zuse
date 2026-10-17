import { DeviceBridgeError, MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import { DeviceBridgeService } from "./service.ts";

const DeviceBridgeControlHandler = MemoizeRpcs.toLayerHandler(
	"deviceBridge.control",
	(action) =>
		Effect.gen(function* () {
			const { broker } = yield* DeviceBridgeService;
			return yield* Effect.tryPromise({
				try: () =>
					action._tag === "status" ? broker.status() : broker.handle(action),
				catch: (cause) =>
					new DeviceBridgeError({
						reason:
							cause instanceof Error ? cause.message : "Device bridge failed",
					}),
			});
		}),
);

const SetEnabled = MemoizeRpcs.toLayerHandler(
	"deviceBridge.setEnabled",
	({ enabled }) =>
		Effect.gen(function* () {
			const service = yield* DeviceBridgeService;
			return yield* Effect.tryPromise({
				try: () => service.setEnabled(enabled),
				catch: () =>
					new DeviceBridgeError({
						reason: "Could not change cloud device access",
					}),
			});
		}),
);
export const DeviceBridgeHandlersLayer = Layer.merge(
	DeviceBridgeControlHandler,
	SetEnabled,
);
