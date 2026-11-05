import type { AutomationDispatchInput } from "@zuse/contracts";
import { Effect, Queue } from "effect";

export type CloudAutomationEvent = AutomationDispatchInput & {
	readonly id: string;
};
/** The permanent set is deliberately narrow; unknown failures remain retryable. */
const permanentRejection = (error: unknown): string | undefined => {
	if (
		error === null ||
		typeof error !== "object" ||
		!("_tag" in error) ||
		error._tag !== "AutomationError" ||
		!("message" in error)
	)
		return;
	const message = error.message;
	if (
		typeof message === "string" &&
		[
			"Automation not found.",
			"Automation is paused.",
			"Event does not match any configured trigger.",
		].includes(message)
	)
		return message;
};
export const deliverCloudAutomationEvents = <DispatchError, AckError>(input: {
	readonly events: readonly CloudAutomationEvent[];
	readonly dispatch: (
		event: AutomationDispatchInput,
	) => Effect.Effect<unknown, DispatchError>;
	readonly ack: (
		id: string,
		rejection?: string,
	) => Effect.Effect<unknown, AckError>;
}) =>
	Effect.forEach(
		input.events,
		(event) =>
			Effect.gen(function* () {
				const dispatched = yield* input
					.dispatch({
						...event,
						context: { ...event.context, mailboxEventId: event.id },
					})
					.pipe(Effect.result);
				if (dispatched._tag === "Failure") {
					const rejection = permanentRejection(dispatched.failure);
					if (!rejection) {
						yield* Effect.logWarning("automation event deferred", {
							id: event.id,
							automationId: event.automationId,
						});
						return;
					}
					// Persist the rejection in the control-plane receipt before discarding it.
					yield* input.ack(event.id, rejection);
					yield* Effect.logWarning("automation event rejected", {
						id: event.id,
						automationId: event.automationId,
						reason: rejection,
					});
					return;
				}
				yield* input.ack(event.id);
			}).pipe(
				Effect.catch(() =>
					Effect.logWarning("automation event acknowledgement deferred", {
						id: event.id,
					}),
				),
			),
		{ concurrency: 1, discard: true },
	);

/** Idle pumps have no timer; a timer exists only while durable work needs retry. */
export const runCloudAutomationPump = <E>(input: {
	readonly wake: Queue.Queue<void>;
	readonly cycle: Effect.Effect<boolean, E>;
	readonly retryMilliseconds?: number;
}) =>
	Effect.forever(
		Effect.gen(function* () {
			const result = yield* input.cycle.pipe(Effect.result);
			const wake = Queue.take(input.wake);
			yield* result._tag === "Failure" || result.success
				? Effect.raceFirst(wake, Effect.sleep(input.retryMilliseconds ?? 10000))
				: wake;
		}),
	);
