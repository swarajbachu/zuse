import type { ResourceDriver } from "@zuse/client-runtime/client-bus";
import type { ResourceActivation } from "@zuse/client-runtime/environment-runtime";
import {
	type EnvironmentRef,
	makeResourceKey,
	type ResourceKey,
} from "@zuse/client-runtime/resource-ref";
import {
	emptyResourceView,
	type ResourceView,
} from "@zuse/client-runtime/resource-state";
import type { MachineResourceSample } from "@zuse/contracts";
import { Cause, Effect, Fiber, Stream } from "effect";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { MemoizeClient } from "./rpc-client.ts";
import {
	getRendererClientBus,
	registerRendererResourceDriver,
} from "./session-timeline-client-bus.ts";

export type MachineResourcesData = Readonly<{
	sample: MachineResourceSample;
}>;
type MachineResourcesKey = ResourceKey<MachineResourcesData>;

const keyFor = (ref: EnvironmentRef): MachineResourcesKey =>
	makeResourceKey("machine-resources", ref);

const refFrom = (key: ResourceKey<unknown>): EnvironmentRef | null =>
	key.kind === "machine-resources"
		? { environmentId: key.ref.environmentId }
		: null;

const makeDriver = (): ResourceDriver<MemoizeClient, MachineResourcesData> => {
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	let active = false;
	return {
		start: (context) => {
			const ref = refFrom(context.key);
			if (ref === null) return;
			active = true;
			const epoch = `machine-resources:${context.generation}:${crypto.randomUUID()}`;
			let version = 0;
			const program = Stream.runForEach(
				context.client["machine.resources.watch"]({}),
				(sample) =>
					Effect.sync(() => {
						if (!active || !context.isCurrent()) return;
						version += 1;
						context.emit({
							data: { sample },
							cursor: { epoch, version },
							resetEpoch: version === 1,
							sync: "live",
						});
					}),
			).pipe(
				// Stats are cosmetic. A runtime that predates this RPC (or a stream
				// dropped by a pausing workspace) must never be treated as a
				// connection fault — tearing down the shared environment connection
				// here would put pause/resume into a reconnect loop. Fail quietly;
				// the rows simply stay hidden until a capable runtime reconnects.
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						if (active && !Cause.hasInterruptsOnly(cause)) {
							context.emit({ sync: "failed" });
						}
					}),
				),
			);
			fiber = Effect.runFork(program);
		},
		stop: () => {
			active = false;
			const running = fiber;
			fiber = null;
			if (running !== null) void Effect.runPromise(Fiber.interrupt(running));
		},
	};
};

registerRendererResourceDriver("machine-resources", (key) =>
	refFrom(key) === null
		? null
		: (makeDriver() as ResourceDriver<MemoizeClient, unknown>),
);

const EMPTY = emptyResourceView<MachineResourcesData>();

/** Live CPU / memory / disk samples for the environment's host machine. */
export const useMachineResources = (
	ref: EnvironmentRef | null,
	activation: ResourceActivation = "connect",
): ResourceView<MachineResourcesData> => {
	const key = useMemo(
		() => (ref === null ? null : keyFor(ref)),
		[ref?.environmentId],
	);
	const bus = getRendererClientBus();
	useEffect(() => {
		if (key === null) return;
		return bus.retain(key, { activation }).release;
	}, [activation, bus, key]);
	const subscribe = useCallback(
		(listener: () => void) =>
			key === null ? () => undefined : bus.subscribe(key, listener),
		[bus, key],
	);
	const snapshot = useCallback(
		() => (key === null ? EMPTY : (bus.snapshot(key) ?? EMPTY)),
		[bus, key],
	);
	return useSyncExternalStore(subscribe, snapshot, snapshot);
};
