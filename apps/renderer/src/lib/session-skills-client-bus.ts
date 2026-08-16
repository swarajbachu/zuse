import type { ResourceDriver } from "@zuse/client-runtime/client-bus";
import type { ResourceActivation } from "@zuse/client-runtime/environment-runtime";
import {
	makeResourceKey,
	type ResourceKey,
	type SessionRef,
} from "@zuse/client-runtime/resource-ref";
import {
	emptyResourceView,
	type ResourceView,
} from "@zuse/client-runtime/resource-state";
import type { Skill } from "@zuse/contracts";
import { Cause, Effect, Fiber, Stream } from "effect";
import { useMemo } from "react";
import type { MemoizeClient } from "./rpc-client.ts";
import {
	getRendererClientBus,
	registerRendererResourceDriver,
} from "./session-timeline-client-bus.ts";
import { useClientBusResource } from "./use-client-bus-resource.ts";

type SessionSkillsData = Readonly<{ skills: ReadonlyArray<Skill> }>;
type SessionSkillsKey = ResourceKey<SessionSkillsData>;

const keyFor = (ref: SessionRef): SessionSkillsKey =>
	makeResourceKey("session-skills", ref);

const refFrom = (key: ResourceKey<unknown>): SessionRef | null =>
	key.kind === "session-skills" && "sessionId" in key.ref ? key.ref : null;

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const isSkillResourceFailure = (cause: unknown): boolean => {
	const tag =
		typeof cause === "object" && cause !== null && "_tag" in cause
			? cause._tag
			: null;
	return tag === "SessionNotFoundError";
};

const makeDriver = (): ResourceDriver<MemoizeClient, SessionSkillsData> => {
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	let active = false;
	return {
		start: (context) => {
			const ref = refFrom(context.key);
			if (ref === null) return;
			active = true;
			const epoch = `session-skills:${context.generation}:${crypto.randomUUID()}`;
			let version = 0;
			const program = Stream.runForEach(
				context.client["skill.stream"]({ sessionId: ref.sessionId }),
				(skills) =>
					Effect.sync(() => {
						if (!active || !context.isCurrent()) return;
						version += 1;
						context.emit({
							data: { skills },
							cursor: { epoch, version },
							resetEpoch: version === 1,
							sync: "live",
						});
					}),
			).pipe(
				Effect.andThen(
					Effect.fail(new Error("Session skill stream ended unexpectedly")),
				),
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						if (active && !Cause.hasInterruptsOnly(cause)) {
							const failure = Cause.squash(cause);
							context.emit({ sync: "failed" });
							if (!isSkillResourceFailure(failure)) {
								getRendererClientBus().reportConnectionFault(
									ref.environmentId,
									{ phase: "failed", message: messageOf(failure) },
									context.generation,
								);
							}
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

registerRendererResourceDriver("session-skills", (key) =>
	refFrom(key) === null
		? null
		: (makeDriver() as ResourceDriver<MemoizeClient, unknown>),
);

const EMPTY = emptyResourceView<SessionSkillsData>();

export const useSessionSkills = (
	ref: SessionRef,
	activation: ResourceActivation = "connect",
): ResourceView<SessionSkillsData> => {
	const key = useMemo(() => keyFor(ref), [ref.environmentId, ref.sessionId]);
	return useClientBusResource(key, EMPTY, activation);
};
