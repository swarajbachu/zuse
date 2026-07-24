import type {
	AgentEvent,
	AgentTurnId,
	ProviderEventEnvelope,
} from "@zuse/contracts";
import { Effect, Ref, Stream } from "effect";
import type { ProviderSessionHandle } from "./driver.ts";

type ActiveTurn = {
	readonly turnId: AgentTurnId;
};

export interface TurnScopedProviderSessionHandle
	extends Omit<ProviderSessionHandle, "events" | "send" | "interrupt"> {
	readonly events: Stream.Stream<ProviderEventEnvelope>;
	readonly send: (
		turnId: AgentTurnId,
		...args: Parameters<ProviderSessionHandle["send"]>
	) => Effect.Effect<void>;
	readonly interrupt: (turnId: AgentTurnId) => Effect.Effect<void>;
}

const sessionEventTags = new Set<AgentEvent["_tag"]>([
	"Started",
	"Auth",
	"Version",
	"Capabilities",
	"SessionCursor",
	"ProviderNotificationMetadata",
	"PermissionModeChanged",
	"GoalUpdated",
	"GoalCleared",
	"UsageLimit",
]);

const sessionEnvelope = (event: AgentEvent): ProviderEventEnvelope => ({
	scope: "session",
	event,
});

const turnEnvelope = (
	turnId: AgentTurnId,
	event: AgentEvent,
): ProviderEventEnvelope => ({ scope: "turn", turnId, event });

/**
 * Converts every legacy provider handle at one kernel boundary. This is the
 * only place allowed to correlate native events with an application turn.
 * The server admits at most one provider turn through this handle, so a new
 * send cannot silently supersede an unsettled turn.
 */
export const makeTurnScopedSessionHandle = (
	handle: ProviderSessionHandle,
	initialTurnId?: AgentTurnId,
): Effect.Effect<TurnScopedProviderSessionHandle> =>
	Effect.gen(function* () {
		const activeTurn = yield* Ref.make<ActiveTurn | null>(
			initialTurnId === undefined ? null : { turnId: initialTurnId },
		);

		const normalize = (
			event: AgentEvent,
		): Effect.Effect<ReadonlyArray<ProviderEventEnvelope>> =>
			Ref.modify(
				activeTurn,
				(
					active,
				): readonly [
					ReadonlyArray<ProviderEventEnvelope>,
					ActiveTurn | null,
				] => {
				if (sessionEventTags.has(event._tag)) {
					return [[sessionEnvelope(event)], active] as const;
				}

				if (event._tag === "Status") {
					if (active !== null && event.status === "idle") {
						return [
							[
								turnEnvelope(active.turnId, {
									_tag: "Completed",
									reason: "ended",
								}),
								sessionEnvelope(event),
							],
							null,
						] as const;
					}
					if (
						active !== null &&
						(event.status === "closed" || event.status === "error")
					) {
						return [
							[
								turnEnvelope(active.turnId, {
									_tag: "Error",
									message: `Provider entered ${event.status} state`,
								}),
								turnEnvelope(active.turnId, {
									_tag: "Completed",
									reason: "error",
								}),
								sessionEnvelope(event),
							],
							null,
						] as const;
					}
					return [[sessionEnvelope(event)], active] as const;
				}

				if (active === null) return [[], null] as const;

				if (event._tag === "Completed") {
					return [[turnEnvelope(active.turnId, event)], null] as const;
				}
				if (event._tag === "Interrupted") {
					return [
						[
							turnEnvelope(active.turnId, event),
							turnEnvelope(active.turnId, {
								_tag: "Completed",
								reason: "interrupted",
							}),
						],
						null,
					] as const;
				}
				if (event._tag === "Error") {
					return [
						[
							turnEnvelope(active.turnId, event),
							turnEnvelope(active.turnId, {
								_tag: "Completed",
								reason: "error",
							}),
						],
						null,
					] as const;
				}
				return [[turnEnvelope(active.turnId, event)], active] as const;
				},
			);

		const finalizeUnexpectedExit = Ref.modify(
			activeTurn,
			(
				active,
			): readonly [
				ReadonlyArray<ProviderEventEnvelope>,
				ActiveTurn | null,
			] => {
			if (active === null) return [[], null] as const;
			return [
				[
					turnEnvelope(active.turnId, {
						_tag: "Error",
						message: "Provider event stream ended before the turn settled",
					}),
					turnEnvelope(active.turnId, {
						_tag: "Completed",
						reason: "error",
					}),
				],
				null,
			] as const;
			},
		);

		const sourceEvents = handle.events.pipe(
			Stream.catchCause((cause) =>
				Stream.fromIterable<AgentEvent>([
					{
						_tag: "Error",
						message: `Provider event stream failed: ${String(cause)}`,
					},
				]),
			),
		);
		const normalizedEvents = Stream.mapEffect(sourceEvents, normalize).pipe(
			Stream.flatMap((events) => Stream.fromIterable(events)),
			Stream.concat(
				Stream.fromEffect(finalizeUnexpectedExit).pipe(
					Stream.flatMap((events) => Stream.fromIterable(events)),
				),
			),
		);

		return {
			...handle,
			events: normalizedEvents,
			send: (turnId, ...args) =>
				Ref.modify(activeTurn, (active) => {
					if (active !== null) {
						if (active.turnId === turnId) {
							return [Effect.void, active] as const;
						}
						return [
							Effect.die(
								new Error(
									`Cannot start turn ${turnId}; turn ${active.turnId} is still active`,
								),
							),
							active,
						] as const;
					}
					return [handle.send(...args), { turnId }] as const;
				}).pipe(
					Effect.flatten,
					Effect.catchCause((cause) =>
						Ref.update(activeTurn, (active) =>
							active?.turnId === turnId ? null : active,
						).pipe(Effect.andThen(Effect.failCause(cause))),
					),
				),
			interrupt: (turnId) =>
				Effect.flatMap(Ref.get(activeTurn), (active) => {
					if (active?.turnId !== turnId) {
						return Effect.die(
							new Error(
								`Cannot interrupt turn ${turnId}; current turn is ${active?.turnId ?? "none"}`,
							),
						);
					}
					return handle.interrupt();
				}),
		};
	});
