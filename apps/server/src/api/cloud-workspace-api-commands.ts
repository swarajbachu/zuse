import {
	CLOUD_RUNTIME_TURN_REPLY_MAX_LENGTH,
	type CloudRuntimeCommand,
	type CloudRuntimeCommandList,
	MessageContent,
	type TurnSettlementOutcome,
} from "@zuse/contracts";
import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import { cloudRuntimeCommandTurnId } from "@zuse/utils/cloud-api";
import {
	Cause,
	Effect,
	Option,
	Result,
	Schedule,
	Schema,
	Semaphore,
	Stream,
} from "effect";

/**
 * Pull-based delivery of public-API messages into the in-sandbox runtime.
 * The api stores pending commands durably and nudges the runtime through a
 * `runtime.command` gateway control frame; this pump then fetches and injects
 * the oldest command through the idempotent domain path
 * (`MessageService.sendMessage` with api-minted command/turn ids), and acks
 * so the api marks it delivered. A failed injection is deliberately not
 * acked — the row stays pending until a later wake-up.
 */
export interface CloudApiCommandPump {
	/** Best-effort reconnect/nudge drain; overlapping signals are coalesced. */
	readonly drain: Effect.Effect<void>;
	/** Settlement is a causal wake-up and must wait behind an in-flight ACK. */
	readonly drainAfterSettlement: (turnId: string) => Effect.Effect<void>;
}

export const makeCloudApiCommandPump = Effect.fn(
	"CloudWorkspaceRuntime.makeApiCommandPump",
)(function* (input: {
	readonly fetchCommands: Effect.Effect<CloudRuntimeCommandList, unknown>;
	readonly deliver: (
		command: CloudRuntimeCommand & { readonly turnId: string },
	) => Effect.Effect<string, unknown>;
	readonly ack: (
		messageId: string,
		turnId: string,
		commandTurnId: string,
	) => Effect.Effect<unknown, unknown>;
}) {
	const lock = yield* Semaphore.make(1);
	let nudgeRevision = 0;
	const drainOne = Effect.gen(function* () {
		const list = yield* input.fetchCommands;
		const command = list.commands.reduce<CloudRuntimeCommand | undefined>(
			(oldest, candidate) =>
				oldest === undefined || candidate.seq < oldest.seq ? candidate : oldest,
			undefined,
		);
		if (command === undefined) return { kind: "empty" } as const;
		const normalizedCommand = {
			...command,
			turnId: command.turnId ?? cloudRuntimeCommandTurnId(command.messageId),
		};
		// MessageService currently turns domain conflicts into defects. Capture the
		// complete exit so a busy session leaves the oldest command pending instead
		// of killing the runtime pump or letting a later command overtake it.
		const delivered = yield* Effect.exit(input.deliver(normalizedCommand));
		if (delivered._tag === "Failure") {
			yield* Effect.logWarning("cloud api command delivery failed", {
				messageId: command.messageId,
				turnId: normalizedCommand.turnId,
				cause: String(delivered.cause),
			});
			return { kind: "blocked" } as const;
		}
		const acknowledged = yield* Effect.exit(
			input.ack(command.messageId, delivered.value, normalizedCommand.turnId),
		);
		if (acknowledged._tag === "Failure") {
			yield* Effect.logWarning("cloud api command acknowledgement failed", {
				messageId: command.messageId,
				turnId: delivered.value,
				cause: String(acknowledged.cause),
			});
			return { kind: "blocked" } as const;
		}
		return { kind: "delivered", turnId: delivered.value } as const;
	});
	const runDrain = drainOne.pipe(
		Effect.retry(Schedule.recurs(3)),
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.interrupt
				: Effect.logWarning("cloud api command fetch failed", {
						cause: String(cause),
					}).pipe(Effect.as({ kind: "blocked" } as const)),
		),
	);
	const runNotifiedDrain = Effect.gen(function* () {
		while (true) {
			const beforeFetch = nudgeRevision;
			const outcome = yield* runDrain;
			// An empty response may have been selected before a concurrent command
			// committed. Retain that command's nudge while the fetch is in flight.
			// A delivered or blocked turn must still wait for its settlement signal.
			if (outcome.kind !== "empty" || beforeFetch === nudgeRevision)
				return { ...outcome, nudgeRevision: beforeFetch };
		}
	});
	const drain: Effect.Effect<void> = Effect.gen(function* () {
		nudgeRevision += 1;
		while (true) {
			const result = yield* lock.withPermitsIfAvailable(1)(runNotifiedDrain);
			// Check again after releasing the permit: a notification can arrive
			// between the last empty-page check and the permit finalizer.
			if (
				Option.isNone(result) ||
				result.value.kind !== "empty" ||
				result.value.nudgeRevision === nudgeRevision
			)
				return;
		}
	});
	const drainAfterSettlement = (settledTurnId: string): Effect.Effect<void> =>
		lock
			.withPermits(1)(
				Effect.gen(function* () {
					const acknowledged = yield* runNotifiedDrain;
					// If the turn event raced an earlier lost ACK, the first pass only
					// repairs that same settled row. The permit remains held while one
					// more pass advances to the next FIFO command.
					if (
						acknowledged.kind === "delivered" &&
						acknowledged.turnId === settledTurnId
					)
						return yield* runNotifiedDrain;
					return acknowledged;
				}),
			)
			.pipe(
				Effect.flatMap((outcome) =>
					outcome.kind === "empty" && outcome.nudgeRevision !== nudgeRevision
						? drain
						: Effect.void,
				),
			);
	return {
		drain,
		drainAfterSettlement,
	} satisfies CloudApiCommandPump;
});

const boundedReplyExcerpt = (
	full: string,
): { readonly text: string; readonly truncated: boolean } => {
	const truncated = full.length > CLOUD_RUNTIME_TURN_REPLY_MAX_LENGTH;
	return {
		text: truncated ? full.slice(0, CLOUD_RUNTIME_TURN_REPLY_MAX_LENGTH) : full,
		truncated,
	};
};

const decodeMessageContent = Schema.decodeUnknownResult(
	Schema.fromJsonString(MessageContent),
);

export interface CloudApiTurnEvent {
	readonly turnId: string;
	readonly outcome: TurnSettlementOutcome;
	readonly settledAt: number;
	readonly replyText: string;
	readonly replyTruncated: boolean;
}

/**
 * Replays one session's durable event stream from the caller's cursor and then
 * tails it. `Stream.runForEach` keeps Api publication and the subsequent
 * command drain serialized. Reply text is selected by exact domain turn id,
 * never by whichever assistant message happens to be newest in the timeline.
 */
export const runCloudApiTurnEventStream = (input: {
	readonly events: ReturnType<SessionDomainApi["events"]>;
	readonly publish: (
		event: CloudApiTurnEvent,
	) => Effect.Effect<unknown, unknown>;
	readonly onSettled: (turnId: string) => Effect.Effect<unknown, unknown>;
}): Effect.Effect<void, unknown> =>
	Effect.suspend(() => {
		const assistantReplyByTurn = new Map<string, string>();
		return input.events.pipe(
			Stream.runForEach((record) => {
				const event = record.event;
				if (
					event._tag === "MessagePersisted" &&
					event.turnId !== null &&
					event.role === "assistant"
				) {
					const content = decodeMessageContent(event.contentJson);
					if (
						Result.isSuccess(content) &&
						content.success._tag === "assistant"
					) {
						assistantReplyByTurn.set(event.turnId, content.success.text);
					}
					return Effect.void;
				}
				if (event._tag !== "TurnSettled") return Effect.void;
				const reply = boundedReplyExcerpt(
					assistantReplyByTurn.get(event.turnId) ?? "",
				);
				return input
					.publish({
						turnId: event.turnId,
						outcome: event.outcome,
						settledAt: event.settledAt,
						replyText: reply.text,
						replyTruncated: reply.truncated,
					})
					.pipe(
						Effect.tap(() =>
							Effect.sync(() => assistantReplyByTurn.delete(event.turnId)),
						),
						Effect.andThen(input.onSettled(event.turnId)),
						Effect.asVoid,
					);
			}),
		);
	});
