import type {
	EnvironmentId,
	SessionTimelineFrame,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { Cause, Effect, Fiber, Stream } from "effect";
import type { ResourceDriver } from "./client-bus";
import type { ResourceKey, SessionRef } from "./resource-ref";
import type { SyncPhase } from "./resource-state";
import {
	reduceSessionTimelineFrame,
	restoreSessionTimelineState,
	type SessionTimelineState,
} from "./session-timeline";

export type SessionTimelineDriverClient = Readonly<{
	"session.events": (
		input: Readonly<{
			sessionId: SessionRef["sessionId"];
			afterVersion?: number;
			streamEpoch?: string;
			hasProjection?: boolean;
		}>,
	) => Stream.Stream<SessionTimelineFrame, unknown>;
}>;

const syncPhase = (state: SessionTimelineState): SyncPhase => {
	switch (state.phase) {
		case "empty":
			return "empty";
		case "cached":
			return "cached";
		case "synchronizing":
			return "synchronizing";
		case "live":
			return "live";
		case "stale":
		case "deleted":
			return "stale";
	}
};

const isSettlement = (frame: SessionTimelineFrame): boolean =>
	frame.kind === "event" && frame.event._tag === "TurnSettled";

const sameCursor = (
	left: SessionTimelineState["cursor"],
	right: SessionTimelineState["cursor"],
): boolean =>
	left === right ||
	(left !== null &&
		right !== null &&
		left.epoch === right.epoch &&
		left.version === right.version);

export type SessionTimelineDriverOptions = Readonly<{
	reportFailure: (
		environmentId: EnvironmentId,
		generation: number,
		cause: unknown,
	) => void;
	checkpointMs?: number;
	checkpointEvents?: number;
	schedule?: (delayMs: number, task: () => void) => () => void;
}>;

/**
 * Canonical cursor/reducer/checkpoint loop shared by every client platform.
 * Platform adapters own persistence and transports; this driver alone decides
 * stream resumption, frame reduction, cursor advancement, and persistence
 * checkpoints.
 */
export const makeSessionTimelineResourceDriver = <
	Client extends SessionTimelineDriverClient,
>(
	options: SessionTimelineDriverOptions,
): ResourceDriver<Client, SessionTimelineProjection> => {
	const checkpointMs = options.checkpointMs ?? 150;
	const checkpointEvents = options.checkpointEvents ?? 16;
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	let checkpointCancel: (() => void) | null = null;
	let active = false;

	return {
		start: (context) => {
			if (!isSessionTimelineKey(context.key)) return;
			active = true;
			const ref = context.key.ref;
			let state = restoreSessionTimelineState(context.data, context.cursor);
			let eventsSinceCheckpoint = 0;
			const clearCheckpoint = (): void => {
				checkpointCancel?.();
				checkpointCancel = null;
			};
			const persistCurrent = (): void => {
				clearCheckpoint();
				eventsSinceCheckpoint = 0;
				if (!active || state.projection === null || state.cursor === null)
					return;
				context.emit({
					cursor: state.cursor,
					sync: syncPhase(state),
					persist: true,
				});
			};
			const scheduleCheckpoint = (): void => {
				if (checkpointCancel !== null) return;
				const schedule =
					options.schedule ??
					((delayMs: number, task: () => void) => {
						const timer = setTimeout(task, delayMs);
						return () => clearTimeout(timer);
					});
				checkpointCancel = schedule(checkpointMs, () => {
					checkpointCancel = null;
					persistCurrent();
				});
			};
			const program = Stream.runForEach(
				context.client["session.events"]({
					sessionId: ref.sessionId,
					afterVersion: state.cursor?.version,
					streamEpoch: state.cursor?.epoch,
					hasProjection: state.projection !== null,
				}),
				(frame) =>
					Effect.sync(() => {
						if (!active) return;
						const current = context.snapshot();
						if (current === null) return;
						if (
							current.data !== null &&
							!Object.is(current.data, state.projection) &&
							sameCursor(current.cursor, state.cursor)
						) {
							state = { ...state, projection: current.data };
						}
						const previous = state;
						state = reduceSessionTimelineFrame(state, frame);
						if (state === previous) return;
						const dataChanged = !Object.is(
							previous.projection,
							state.projection,
						);
						const cursorChanged = !sameCursor(previous.cursor, state.cursor);
						const resetEpoch =
							frame.kind === "snapshot" && previous.resetEpoch !== null;
						const persist =
							frame.kind === "synchronized" || isSettlement(frame);
						const accepted = context.emit({
							...(dataChanged && state.projection !== null
								? { data: state.projection }
								: {}),
							...(cursorChanged && state.cursor !== null
								? { cursor: state.cursor }
								: {}),
							sync: syncPhase(state),
							resetEpoch,
							persist,
						});
						if (!accepted) return;
						if (state.phase === "stale") {
							throw new Error(
								state.error ?? "Session timeline continuity check failed",
							);
						}
						if (frame.kind === "event") eventsSinceCheckpoint += 1;
						if (persist) {
							clearCheckpoint();
							eventsSinceCheckpoint = 0;
						} else if (eventsSinceCheckpoint >= checkpointEvents) {
							persistCurrent();
						} else if (frame.kind === "event") {
							scheduleCheckpoint();
						}
					}),
			).pipe(
				Effect.andThen(
					Effect.fail(
						new Error("Session timeline stream completed unexpectedly"),
					),
				),
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						if (active && !Cause.hasInterruptsOnly(cause)) {
							options.reportFailure(
								ref.environmentId,
								context.generation,
								Cause.squash(cause),
							);
						}
					}),
				),
			);
			fiber = Effect.runFork(Effect.yieldNow.pipe(Effect.andThen(program)));
		},
		stop: () => {
			active = false;
			checkpointCancel?.();
			checkpointCancel = null;
			const running = fiber;
			fiber = null;
			if (running !== null) void Effect.runPromise(Fiber.interrupt(running));
		},
	};
};

const isSessionTimelineKey = <Data>(
	key: ResourceKey<Data>,
): key is ResourceKey<Data> & Readonly<{ ref: SessionRef }> =>
	key.kind === "session-timeline" && "sessionId" in key.ref;
