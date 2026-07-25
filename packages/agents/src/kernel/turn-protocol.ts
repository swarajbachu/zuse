import type {
	AgentEvent,
	AgentTurnId,
	ProviderEventEnvelope,
} from "@zuse/contracts";
import { Deferred, Effect, Ref, Stream } from "effect";
import type { ProviderSessionHandle } from "./driver.ts";

type ActiveTurn = {
	readonly turnId: AgentTurnId;
	readonly released: Deferred.Deferred<void>;
};

type NormalizedBatch = {
	readonly events: ReadonlyArray<ProviderEventEnvelope>;
	readonly released?: Deferred.Deferred<void>;
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
		const initialReleased = yield* Deferred.make<void>();
		const activeTurn = yield* Ref.make<ActiveTurn | null>(
			initialTurnId === undefined
				? null
				: { turnId: initialTurnId, released: initialReleased },
		);
		const releaseBatch = (
			batch: NormalizedBatch,
		): Effect.Effect<ReadonlyArray<ProviderEventEnvelope>> =>
			(batch.released === undefined
				? Effect.void
				: Deferred.succeed(batch.released, undefined)
			).pipe(Effect.as(batch.events));

		const normalize = (
			event: AgentEvent,
		): Effect.Effect<ReadonlyArray<ProviderEventEnvelope>> =>
			Ref.modify(
				activeTurn,
				(active): readonly [NormalizedBatch, ActiveTurn | null] => {
					if (sessionEventTags.has(event._tag)) {
						return [{ events: [sessionEnvelope(event)] }, active] as const;
					}

					if (event._tag === "Status") {
						if (active !== null && event.status === "idle") {
							return [
								{
									events: [
										turnEnvelope(active.turnId, {
											_tag: "Completed",
											reason: "ended",
										}),
										sessionEnvelope(event),
									],
									released: active.released,
								},
								null,
							] as const;
						}
						if (
							active !== null &&
							(event.status === "closed" || event.status === "error")
						) {
							return [
								{
									events: [
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
									released: active.released,
								},
								null,
							] as const;
						}
						return [{ events: [sessionEnvelope(event)] }, active] as const;
					}

					if (active === null) return [{ events: [] }, null] as const;

					if (event._tag === "Completed") {
						return [
							{
								events: [turnEnvelope(active.turnId, event)],
								released: active.released,
							},
							null,
						] as const;
					}
					if (event._tag === "Interrupted") {
						return [
							{
								events: [
									turnEnvelope(active.turnId, event),
									turnEnvelope(active.turnId, {
										_tag: "Completed",
										reason: "interrupted",
									}),
								],
								released: active.released,
							},
							null,
						] as const;
					}
					if (event._tag === "Error") {
						return [
							{
								events: [
									turnEnvelope(active.turnId, event),
									turnEnvelope(active.turnId, {
										_tag: "Completed",
										reason: "error",
									}),
								],
								released: active.released,
							},
							null,
						] as const;
					}
					return [
						{ events: [turnEnvelope(active.turnId, event)] },
						active,
					] as const;
				},
			).pipe(Effect.flatMap(releaseBatch));

		const finalizeUnexpectedExit = Ref.modify(
			activeTurn,
			(active): readonly [NormalizedBatch, ActiveTurn | null] => {
				if (active === null) return [{ events: [] }, null] as const;
				return [
					{
						events: [
							turnEnvelope(active.turnId, {
								_tag: "Error",
								message: "Provider event stream ended before the turn settled",
							}),
							turnEnvelope(active.turnId, {
								_tag: "Completed",
								reason: "error",
							}),
						],
						released: active.released,
					},
					null,
				] as const;
			},
		).pipe(Effect.flatMap(releaseBatch));

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
				Effect.gen(function* () {
					const released = yield* Deferred.make<void>();
					const send = yield* Ref.modify(activeTurn, (active) => {
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
						return [handle.send(...args), { turnId, released }] as const;
					});
					yield* send.pipe(
						Effect.catchCause((cause) =>
							Ref.modify(activeTurn, (active) =>
								active?.turnId === turnId
									? [active.released, null]
									: [undefined, active],
							).pipe(
								Effect.flatMap((currentReleased) =>
									currentReleased === undefined
										? Effect.void
										: Deferred.succeed(currentReleased, undefined),
								),
								Effect.andThen(Effect.failCause(cause)),
							),
						),
					);
				}),
			interrupt: (turnId) =>
				Effect.gen(function* () {
					const active = yield* Ref.get(activeTurn);
					if (active?.turnId !== turnId) {
						return yield* Effect.die(
							new Error(
								`Cannot interrupt turn ${turnId}; current turn is ${active?.turnId ?? "none"}`,
							),
						);
					}
					yield* handle.interrupt();
					yield* Deferred.await(active.released);
				}),
		};
	});
