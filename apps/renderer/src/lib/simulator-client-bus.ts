import type { ResourceDriver } from "@zuse/client-runtime/client-bus";
import type { ClientCommand } from "@zuse/client-runtime/client-persistence";
import {
	type ChatRef,
	makeResourceKey,
	resourceKeyId,
	type SimulatorRef,
} from "@zuse/client-runtime/resource-ref";
import { emptyResourceView } from "@zuse/client-runtime/resource-state";
import { SimulatorSessionReveal } from "@zuse/client-runtime/simulators/reveal";
import { SimulatorVideo } from "@zuse/client-runtime/simulators/video";
import {
	CommandId,
	type EnvironmentId,
	type SimulatorState,
} from "@zuse/contracts";
import { Cause, Effect, Fiber, Stream } from "effect";
import { useCallback, useEffect, useMemo, useState } from "react";
import { rightPaneKey, useUiStore } from "../store/ui.ts";
import { errorMessage } from "./error-message.ts";
import { isRpcClientTransportError, type MemoizeClient } from "./rpc-client.ts";
import {
	getRendererClientBus,
	registerRendererResourceDriver,
} from "./session-timeline-client-bus.ts";
import { useClientBusResource } from "./use-client-bus-resource.ts";

const stateEmpty = emptyResourceView<SimulatorState>();
const videoEmpty = emptyResourceView<{ error: string | null }>();
const viewers = new Map<string, SimulatorVideo>();
export const simulatorStateKey = (environmentId: EnvironmentId) =>
	makeResourceKey<SimulatorState>("environment-simulators", { environmentId });
export const simulatorVideoKey = (ref: SimulatorRef) =>
	makeResourceKey<{ error: string | null }>("simulator-video", ref);
export function useSimulatorState(environmentId: EnvironmentId | null) {
	const key = useMemo(
		() => (environmentId ? simulatorStateKey(environmentId) : null),
		[environmentId],
	);
	return useClientBusResource(key, stateEmpty, "connect");
}
export function simulatorCommand<T>(
	environmentId: EnvironmentId,
	kind: string,
	payload: unknown,
): Promise<T> {
	return getRendererClientBus()
		.dispatch<T>({
			environmentId,
			kind,
			commandId: CommandId.make(crypto.randomUUID()),
			resource: null,
			payload,
			retry: "never",
			createdAt: Date.now(),
		} satisfies ClientCommand<unknown, T>)
		.then((receipt) => receipt.result);
}
/** Runs simulator commands for one view, exposing a single pending/error pair. */
export function useSimulatorActions(environmentId: EnvironmentId) {
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const run = useCallback(
		/** Resolves to the command's result, or null after reporting its error. */
		async <T = unknown>(
			kind: string,
			payload: unknown,
			label = kind,
		): Promise<{ readonly result: T } | null> => {
			setPending(label);
			setError(null);
			try {
				return {
					result: await simulatorCommand<T>(environmentId, kind, payload),
				};
			} catch (cause) {
				setError(errorMessage(cause, "Device operation failed"));
				return null;
			} finally {
				setPending((current) => (current === label ? null : current));
			}
		},
		[environmentId],
	);
	return { run, pending, error, setError };
}
registerRendererResourceDriver("environment-simulators", (key) => {
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	const driver: ResourceDriver<MemoizeClient, SimulatorState> = {
		start(context) {
			const epoch = crypto.randomUUID();
			let first = true;
			fiber = Effect.runFork(
				Stream.runForEach(context.client["simulators.state"]({}), (state) =>
					Effect.sync(() => {
						if (context.isCurrent())
							context.emit({
								data: state,
								cursor: { epoch, version: state.revision },
								resetEpoch: first,
								sync: "live",
							});
						first = false;
					}),
				).pipe(
					Effect.catchCause((cause) =>
						Effect.sync(() => {
							if (Cause.hasInterruptsOnly(cause) || !context.isCurrent())
								return;
							context.emit({ sync: "failed" });
							if (isRpcClientTransportError(Cause.squash(cause)))
								getRendererClientBus().reportConnectionFault(
									key.ref.environmentId,
									{ phase: "failed", message: "Device connection lost" },
									context.generation,
								);
						}),
					),
				),
			);
		},
		stop() {
			if (fiber) void Effect.runPromise(Fiber.interrupt(fiber));
			fiber = null;
		},
	};
	return driver as ResourceDriver<MemoizeClient, unknown>;
});
registerRendererResourceDriver("simulator-video", (key) => {
	if (!("deviceId" in key.ref)) return null;
	const ref = key.ref;
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	const driver: ResourceDriver<MemoizeClient, { error: string | null }> = {
		start(context) {
			const epoch = crypto.randomUUID();
			let version = 1;
			context.emit({
				data: { error: null },
				cursor: { epoch, version },
				resetEpoch: true,
				sync: "live",
			});
			fiber = Effect.runFork(
				Stream.runForEach(
					context.client["simulators.frames"]({
						chatId: ref.chatId,
						deviceId: ref.deviceId,
						format: ref.format,
					}),
					(packet) =>
						Effect.promise(async () => {
							if (context.isCurrent())
								await viewers.get(resourceKeyId(key))?.packet(packet);
						}),
				).pipe(
					Effect.catchCause((cause) =>
						Effect.sync(() => {
							if (Cause.hasInterruptsOnly(cause) || !context.isCurrent())
								return;
							const error = Cause.squash(cause);
							const reason = errorMessage(
								error,
								"Device stream disconnected. Retry to reconnect.",
							);
							context.emit({
								data: { error: reason },
								cursor: { epoch, version: ++version },
								sync: "failed",
							});
							if (isRpcClientTransportError(error))
								getRendererClientBus().reportConnectionFault(
									ref.environmentId,
									{ phase: "failed", message: reason },
									context.generation,
								);
						}),
					),
				),
			);
		},
		stop() {
			if (fiber) void Effect.runPromise(Fiber.interrupt(fiber));
			fiber = null;
		},
	};
	return driver as ResourceDriver<MemoizeClient, unknown>;
});
/** Streams one simulator into `canvas` while active; `size` is null until the first frame. */
export function useSimulatorVideo(
	ref: SimulatorRef,
	canvas: HTMLCanvasElement | null,
	active: boolean,
	fallback: () => void,
) {
	const key = useMemo(
		() => simulatorVideoKey(ref),
		[ref.environmentId, ref.chatId, ref.deviceId, ref.format],
	);
	const [size, setSize] = useState<{ width: number; height: number } | null>(
		null,
	);
	useEffect(() => {
		if (!canvas || !active) return;
		// A fresh viewer must report its first frame even if the size is unchanged.
		canvas.width = 0;
		canvas.height = 0;
		setSize(null);
		const viewer = new SimulatorVideo(canvas, fallback, (width, height) =>
			setSize({ width, height }),
		);
		viewers.set(resourceKeyId(key), viewer);
		return () => {
			viewers.delete(resourceKeyId(key));
			viewer.close();
		};
	}, [canvas, active, fallback, key]);
	const view = useClientBusResource(
		active && canvas ? key : null,
		videoEmpty,
		"connect",
	);
	return { view, size };
}
export function simulatorPoint(ref: SimulatorRef, x: number, y: number) {
	return (
		viewers.get(resourceKeyId(simulatorVideoKey(ref)))?.point(x, y) ?? { x, y }
	);
}

/** The first snapshot is a baseline; reconnects must not resurrect dismissed tabs. */
export function useSimulatorReveal(
	ref: ChatRef | null,
	environmentId: EnvironmentId | null,
) {
	const view = useSimulatorState(environmentId);
	const reveal = useMemo(
		() => new SimulatorSessionReveal(),
		[environmentId, ref?.chatId],
	);
	useEffect(() => {
		if (!ref || !view.data) return;
		const sessions = view.data.sessions.filter(
			(session) => session.chatId === ref.chatId,
		);
		for (const session of reveal.update(sessions, view.data.devices)) {
			const state = useUiStore.getState();
			const existing = state.rightPanelsByChat[rightPaneKey(ref)]?.find(
				(panel) =>
					panel.kind === "device" && panel.deviceId === session.deviceId,
			);
			if (!existing) state.openDevicePanel(ref, session.deviceId);
		}
	}, [ref, view.data, reveal]);
	return view.data;
}
