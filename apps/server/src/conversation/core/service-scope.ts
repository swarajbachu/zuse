import { Effect, Fiber, type Scope } from "effect";

/**
 * Durably prepares work and hands its execution to the conversation service
 * lifetime without leaving an interruptible gap between those two actions.
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
