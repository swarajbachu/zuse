import { Effect, Fiber, Stream } from "effect";

export interface StreamOperation {
	readonly done: Promise<void>;
	readonly cancel: () => void;
}

/**
 * The sole renderer execution primitive for bounded, user-launched streams
 * such as OAuth, CLI install/update, and credential transfer progress. Passive
 * synchronization belongs to ClientBus resource drivers instead.
 */
export const runStreamOperation = <Value, Error>(
	stream: Stream.Stream<Value, Error>,
	onValue: (value: Value) => void | Promise<void>,
): StreamOperation => {
	const fiber = Effect.runFork(
		Stream.runForEach(stream, (value) =>
			Effect.promise(() => Promise.resolve(onValue(value))),
		),
	);
	return {
		done: Effect.runPromise(Fiber.join(fiber)),
		cancel: () => {
			void Effect.runPromise(Fiber.interrupt(fiber));
		},
	};
};
