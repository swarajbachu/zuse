import type { SessionId, WorkspaceActor } from "@zuse/contracts";
import { Context, Deferred, Effect, Layer } from "effect";

export type WorkspaceExecutionAuthorizer = (
	sessionId: SessionId,
	actor: WorkspaceActor | undefined,
) => Effect.Effect<boolean>;

/** One runtime-wide policy, independent of disposable client connections. */
export const WorkspaceExecutionPolicy = Context.Reference<{
	readonly authorize: WorkspaceExecutionAuthorizer;
	readonly awaitReady: Effect.Effect<void>;
	readonly markReady: Effect.Effect<void>;
	readonly isReady: boolean;
	readonly bind: (
		authorize: WorkspaceExecutionAuthorizer,
	) => Effect.Effect<void>;
}>("zuse/conversation/WorkspaceExecutionPolicy", {
	defaultValue: () => ({
		authorize: (_sessionId, actor) => Effect.succeed(actor === undefined),
		awaitReady: Effect.void,
		markReady: Effect.void,
		isReady: true,
		bind: () => Effect.die("Workspace execution policy was not initialized"),
	}),
});

/** Cloud recovery waits until bootstrap has established ownership and credentials. */
export const PendingWorkspaceExecutionPolicy = Layer.effect(
	WorkspaceExecutionPolicy,
	Effect.gen(function* () {
		const policy = yield* Deferred.make<WorkspaceExecutionAuthorizer>();
		const ready = yield* Deferred.make<void>();
		let prepared = false;
		return {
			authorize: (sessionId, actor) =>
				Deferred.await(ready).pipe(
					Effect.andThen(
						Effect.flatMap(Deferred.await(policy), (authorize) =>
							authorize(sessionId, actor),
						),
					),
				),
			awaitReady: Deferred.await(ready),
			markReady: Effect.sync(() => {
				prepared = true;
			}).pipe(
				Effect.andThen(Deferred.succeed(ready, undefined)),
				Effect.asVoid,
			),
			get isReady() {
				return prepared;
			},
			bind: (authorize) =>
				Deferred.succeed(policy, authorize).pipe(Effect.asVoid),
		};
	}),
);
