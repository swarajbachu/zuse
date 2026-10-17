import { Effect, Stream } from "effect";

/** A new chat can mount before its session row is committed. Retry only that
 * registration race, before receiving any data, without reconnecting sibling
 * resources or retrying access denials and failures of established sessions. */
export const waitForSessionRegistration = <A, E, R>(
	open: () => Stream.Stream<A, E, R>,
): Stream.Stream<A, E, R> =>
	Stream.suspend(() => {
		let received = false;
		const attempt = (remaining: number): Stream.Stream<A, E, R> =>
			Stream.suspend(open).pipe(
				Stream.tap(() =>
					Effect.sync(() => {
						received = true;
					}),
				),
				Stream.catch((error) => {
					if (
						received ||
						remaining === 0 ||
						typeof error !== "object" ||
						error === null ||
						!("_tag" in error) ||
						error._tag !== "SessionNotFoundError"
					)
						return Stream.fail(error);
					return Stream.fromEffect(Effect.sleep("100 millis")).pipe(
						Stream.flatMap(() => attempt(remaining - 1)),
					);
				}),
			);
		return attempt(49);
	});
