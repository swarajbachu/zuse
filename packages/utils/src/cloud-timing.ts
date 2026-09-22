import { Clock, Effect } from "effect";

/** Correlation fields only: never include prompts, credentials, URLs or bodies. */
interface CloudTimingFields {
	readonly provider?: string;
	readonly runtimeGeneration?: number;
	readonly commandId?: string;
	readonly messageId?: string;
	readonly reason?: string;
}

export type CloudTimingContext = CloudTimingFields &
	(
		| { readonly workspaceId: string; readonly providerSandboxId?: string }
		| { readonly workspaceId?: never; readonly providerSandboxId: string }
	);

export const cloudTimingEvent = (
	context: CloudTimingContext,
	stage: string,
): void => {
	console.info("[cloud-timing]", { ...context, stage, atMs: Date.now() });
};

/** Emit both boundaries, including failures, without logging sensitive errors. */
export const measureCloudStage =
	(context: CloudTimingContext, stage: string) =>
	<A, E, R>(operation: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
		Effect.gen(function* () {
			const startedAtMs = yield* Clock.currentTimeMillis;
			const started = performance.now();
			console.info("[cloud-timing]", {
				...context,
				stage,
				event: "start",
				atMs: startedAtMs,
			});
			return yield* operation.pipe(
				Effect.onExit((exit) =>
					Effect.sync(() => {
						console.info("[cloud-timing]", {
							...context,
							stage,
							event: "end",
							atMs: Date.now(),
							durationMs: performance.now() - started,
							outcome: exit._tag,
						});
					}),
				),
			);
		});
