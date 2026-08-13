import type { ResourceDriver } from "@zuse/client-runtime/client-bus";
import type {
	ClientCommand,
	CommandReceipt,
} from "@zuse/client-runtime/client-persistence";
import {
	makeResourceKey,
	type ResourceKey,
	resourceKeyId,
	type WorktreeRef,
} from "@zuse/client-runtime/resource-ref";
import {
	EnvironmentId,
	type FolderId,
	type WorktreeId,
	type WorktreeSetupEvent,
} from "@zuse/contracts";
import { Cause, Effect, Fiber, Stream } from "effect";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import type { MemoizeClient } from "./rpc-client.ts";
import {
	getRendererClientBus,
	registerRendererResourceDriver,
} from "./session-timeline-client-bus.ts";

type WorktreeSetupData = Readonly<{ event: WorktreeSetupEvent }>;

const refFrom = (key: ResourceKey<unknown>): WorktreeRef | null =>
	key.kind === "worktree-setup" &&
	"worktreeId" in key.ref &&
	"projectId" in key.ref
		? key.ref
		: null;

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const terminal = (event: WorktreeSetupEvent): boolean =>
	event._tag === "status" &&
	(event.status === "succeeded" ||
		event.status === "failed" ||
		event.status === "skipped");

const makeDriver = (): ResourceDriver<MemoizeClient, WorktreeSetupData> => {
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	let active = false;
	let settled = false;
	return {
		start: (context) => {
			const ref = refFrom(context.key);
			if (ref === null) return;
			active = true;
			settled = false;
			const epoch = `worktree-setup:${context.generation}:${crypto.randomUUID()}`;
			let version = 0;
			const program = Stream.runForEach(
				context.client["worktree.setupStream"]({ worktreeId: ref.worktreeId }),
				(event) =>
					Effect.sync(() => {
						if (!active || !context.isCurrent()) return;
						version += 1;
						settled = terminal(event);
						context.emit({
							data: { event },
							cursor: { epoch, version },
							resetEpoch: version === 1,
							sync: "live",
						});
					}),
			).pipe(
				Effect.andThen(
					Effect.suspend(() =>
						settled
							? Effect.void
							: Effect.fail(
									new Error("Worktree setup stream ended unexpectedly"),
								),
					),
				),
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						if (!active || Cause.hasInterruptsOnly(cause)) return;
						context.emit({ sync: "failed" });
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

registerRendererResourceDriver("worktree-setup", (key) =>
	refFrom(key) === null
		? null
		: (makeDriver() as ResourceDriver<MemoizeClient, unknown>),
);

const followers = new Map<string, () => void>();

export const followWorktreeSetup = (
	projectId: FolderId,
	worktreeId: WorktreeId,
	onEvent: (event: WorktreeSetupEvent) => void,
): void => {
	const environmentId = EnvironmentId.make(
		useEnvironmentCatalogStore.getState().activeEnvironmentId,
	);
	const key = makeResourceKey<WorktreeSetupData>("worktree-setup", {
		environmentId,
		projectId,
		worktreeId,
	} satisfies WorktreeRef);
	const id = resourceKeyId(key);
	if (followers.has(id)) return;
	const bus = getRendererClientBus();
	const lease = bus.retain(key, { activation: "connect" });
	let appliedVersion = -1;
	const stop = () => {
		const current = followers.get(id);
		if (current !== stop) return;
		followers.delete(id);
		unsubscribe();
		lease.release();
	};
	const publish = () => {
		const view = bus.snapshot(key);
		if (view.data === null || view.cursor?.version === appliedVersion) return;
		appliedVersion = view.cursor?.version ?? appliedVersion + 1;
		onEvent(view.data.event);
		if (terminal(view.data.event)) queueMicrotask(stop);
	};
	const unsubscribe = bus.subscribe(key, publish);
	followers.set(id, stop);
	publish();
};

export const stopFollowingWorktreeSetup = (
	projectId: FolderId,
	worktreeId: WorktreeId,
): void => {
	const environmentId = EnvironmentId.make(
		useEnvironmentCatalogStore.getState().activeEnvironmentId,
	);
	const key = makeResourceKey<WorktreeSetupData>("worktree-setup", {
		environmentId,
		projectId,
		worktreeId,
	} satisfies WorktreeRef);
	followers.get(resourceKeyId(key))?.();
};

export const dispatchWorktreeCommand = <Payload, Result>(input: {
	readonly environmentId: EnvironmentId;
	readonly projectId: FolderId;
	readonly worktreeId: WorktreeId;
	readonly kind:
		| "worktree.rerunSetup"
		| "worktree.startRun"
		| "worktree.remove";
	readonly commandId: ClientCommand["commandId"];
	readonly payload: Payload;
}): Promise<CommandReceipt<Result>> =>
	getRendererClientBus().dispatch({
		kind: input.kind,
		commandId: input.commandId,
		environmentId: input.environmentId,
		resource: makeResourceKey("worktree-setup", {
			environmentId: input.environmentId,
			projectId: input.projectId,
			worktreeId: input.worktreeId,
		}),
		payload: input.payload,
		retry: "never",
		createdAt: Date.now(),
	});
