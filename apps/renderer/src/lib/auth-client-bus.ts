import type { ResourceDriver } from "@zuse/client-runtime/client-bus";
import {
	makeResourceKey,
	type ResourceKey,
} from "@zuse/client-runtime/resource-ref";
import {
	emptyResourceView,
	type ResourceView,
} from "@zuse/client-runtime/resource-state";
import { type AuthState, EnvironmentId } from "@zuse/contracts";
import { Cause, Effect, Fiber, Stream } from "effect";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import type { MemoizeClient } from "./rpc-client.ts";
import { LOCAL_ENVIRONMENT_KEY } from "./rpc-client.ts";
import {
	getRendererClientBus,
	registerRendererResourceDriver,
} from "./session-timeline-client-bus.ts";

export type EnvironmentAuthData = Readonly<{ state: AuthState }>;

export const environmentAuthResourceKey = (environmentId: EnvironmentId) =>
	makeResourceKey<EnvironmentAuthData>("environment-auth", { environmentId });

const environmentFrom = (key: ResourceKey<unknown>): EnvironmentId | null =>
	key.kind === "environment-auth" && !("sessionId" in key.ref)
		? key.ref.environmentId
		: null;

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const makeDriver = (): ResourceDriver<MemoizeClient, EnvironmentAuthData> => {
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	let active = false;
	return {
		start: (context) => {
			const environmentId = environmentFrom(context.key);
			if (environmentId === null) return;
			active = true;
			const epoch = `auth:${context.generation}:${crypto.randomUUID()}`;
			let version = 0;
			const program = Stream.runForEach(
				context.client["auth.sessionChanges"]({}),
				(state) =>
					Effect.sync(() => {
						if (!active || !context.isCurrent()) return;
						version += 1;
						context.emit({
							data: { state },
							cursor: { epoch, version },
							resetEpoch: version === 1,
							sync: "live",
						});
					}),
			).pipe(
				Effect.andThen(
					Effect.fail(new Error("Auth stream ended unexpectedly")),
				),
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						if (!active || Cause.hasInterruptsOnly(cause)) return;
						context.emit({ sync: "failed" });
						getRendererClientBus().reportConnectionFault(
							environmentId,
							{ phase: "failed", message: messageOf(Cause.squash(cause)) },
							context.generation,
						);
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

registerRendererResourceDriver("environment-auth", (key) =>
	environmentFrom(key) === null
		? null
		: (makeDriver() as ResourceDriver<MemoizeClient, unknown>),
);

const EMPTY = emptyResourceView<EnvironmentAuthData>();

export const useEnvironmentAuth = (): ResourceView<EnvironmentAuthData> => {
	const environmentId = EnvironmentId.make(
		useEnvironmentCatalogStore(
			(state) =>
				state.entries.find((entry) => entry.connectionKind === "local")
					?.environmentId ?? LOCAL_ENVIRONMENT_KEY,
		),
	);
	const key = useMemo(
		() => environmentAuthResourceKey(environmentId),
		[environmentId],
	);
	const bus = getRendererClientBus();
	useEffect(
		() => bus.retain(key, { activation: "connect" }).release,
		[bus, key],
	);
	const subscribe = useCallback(
		(listener: () => void) => bus.subscribe(key, listener),
		[bus, key],
	);
	const snapshot = useCallback(() => bus.snapshot(key) ?? EMPTY, [bus, key]);
	return useSyncExternalStore(subscribe, snapshot, snapshot);
};
