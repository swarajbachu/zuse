import { Effect, Fiber, type Scope } from "effect";

/**
 * Persists work and hands it to the conversation service lifetime without an
 * interruptible gap. Connected callers still await the result, but once the
 * handoff completes their cancellation cannot stop the service-owned fiber.
 */
export const handoffToServiceScope = <A, E, R, EPrepare, RPrepare>(
	prepare: Effect.Effect<void, EPrepare, RPrepare>,
	work: Effect.Effect<A, E, R>,
	scope: Scope.Scope,
): Effect.Effect<A, E | EPrepare, R | RPrepare> =>
	Effect.uninterruptibleMask((restore) =>
		prepare.pipe(
			Effect.andThen(Effect.forkIn(work, scope)),
			Effect.flatMap((fiber) => restore(Fiber.join(fiber))),
		),
	);
