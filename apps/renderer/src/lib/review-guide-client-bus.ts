import type { ResourceDriver } from "@zuse/client-runtime/client-bus";
import type { ResourceActivation } from "@zuse/client-runtime/environment-runtime";
import {
	type ExecutionRef,
	makeResourceKey,
	type ResourceKey,
} from "@zuse/client-runtime/resource-ref";
import { emptyResourceView } from "@zuse/client-runtime/resource-state";
import {
	CommandId,
	type ReviewGuideState,
	type SessionId,
} from "@zuse/contracts";
import { Cause, Effect, Fiber, Stream } from "effect";
import { useMemo } from "react";
import { isRpcClientTransportError, type MemoizeClient } from "./rpc-client.ts";
import {
	getRendererClientBus,
	registerRendererResourceDriver,
} from "./session-timeline-client-bus.ts";
import { useClientBusResource } from "./use-client-bus-resource.ts";

type ReviewGuideData = Readonly<{ state: ReviewGuideState }>;

const KIND = "review-guide";

const reviewGuideKey = (ref: ExecutionRef): ResourceKey<ReviewGuideData> =>
	makeResourceKey(KIND, ref);

const refFrom = (key: ResourceKey<unknown>): ExecutionRef | null =>
	key.kind === KIND && "folderId" in key.ref ? key.ref : null;

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

/** Follows `reviewGuide.stream` while a review surface is on screen. */
const makeDriver = (): ResourceDriver<MemoizeClient, ReviewGuideData> => {
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	let active = false;
	return {
		start: (context) => {
			const ref = refFrom(context.key);
			if (ref === null) return;
			active = true;
			const epoch = `${KIND}:${context.generation}:${crypto.randomUUID()}`;
			let version = 0;
			const program = Stream.runForEach(
				context.client["reviewGuide.stream"]({
					folderId: ref.folderId,
					worktreeId: ref.worktreeId,
				}),
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
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						if (!active || Cause.hasInterruptsOnly(cause)) return;
						context.emit({ sync: "failed" });
						if (!isRpcClientTransportError(Cause.squash(cause))) return;
						getRendererClientBus().reportConnectionFault(
							ref.environmentId,
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

registerRendererResourceDriver(KIND, (key) =>
	refFrom(key) === null
		? null
		: (makeDriver() as ResourceDriver<MemoizeClient, unknown>),
);

const EMPTY_VIEW = emptyResourceView<ReviewGuideData>();

/** The workspace's guided review: the stored guide, any run, availability. */
export const useReviewGuide = (
	ref: ExecutionRef | null,
	activation: ResourceActivation = "connect",
): ReviewGuideState | null => {
	const key = useMemo(
		() => (ref === null ? null : reviewGuideKey(ref)),
		[ref?.environmentId, ref?.folderId, ref?.worktreeId, ref?.rootPath],
	);
	return useClientBusResource(key, EMPTY_VIEW, activation).data?.state ?? null;
};

const dispatch = (
	ref: ExecutionRef,
	kind: "reviewGuide.generate" | "reviewGuide.cancel",
	payload: Record<string, unknown>,
) =>
	getRendererClientBus().dispatch({
		kind,
		commandId: CommandId.make(`${kind}:${crypto.randomUUID()}`),
		environmentId: ref.environmentId,
		resource: reviewGuideKey(ref),
		payload: { folderId: ref.folderId, worktreeId: ref.worktreeId, ...payload },
		retry: "never",
		createdAt: Date.now(),
	});

export const generateReviewGuide = (
	ref: ExecutionRef,
	options: {
		readonly originSessionId?: SessionId | null;
		readonly force?: boolean;
	} = {},
) => dispatch(ref, "reviewGuide.generate", options);

export const cancelReviewGuide = (ref: ExecutionRef) =>
	dispatch(ref, "reviewGuide.cancel", {});
