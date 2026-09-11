import { DeviceBridgeError, MemoizeRpcs } from "@zuse/contracts";
import { Effect } from "effect";
import { DeviceBridgeService } from "./service.ts";
export const DeviceBridgeHandlersLayer = MemoizeRpcs.toLayerHandler(
	"deviceBridge.control",
	(action) =>
		Effect.gen(function* () {
			const { broker } = yield* DeviceBridgeService;
			return yield* Effect.tryPromise({
				try: () =>
					action._tag === "configure"
						? broker.configure(action.enabled)
						: action._tag === "status"
							? broker.status()
							: broker.handle(action),
				catch: (cause) =>
					new DeviceBridgeError({
						reason:
							cause instanceof Error ? cause.message : "Device bridge failed",
					}),
			});
		}),
);
