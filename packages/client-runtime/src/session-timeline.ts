import {
	type Message,
	type SessionStreamCursor,
	type SessionTimelineFrame,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { applyTimelineEvent } from "@zuse/domain/projectors/timeline-reducer";

export type SessionTimelinePhase =
	| "empty"
	| "cached"
	| "synchronizing"
	| "live"
	| "stale"
	| "deleted";

export type OptimisticOverlay = Readonly<{
	messages: Readonly<Record<string, Message>>;
}>;

export type SessionTimelineState = Readonly<{
	projection: SessionTimelineProjection | null;
	/** Cursor for the projection currently held in memory. */
	cursor: SessionStreamCursor | null;
	/** Epoch announced by reset-required while the prior projection stays visible. */
	resetEpoch: string | null;
	/** @deprecated Prefer cursor.version. Kept while renderer selectors migrate. */
	appliedVersion: number;
	phase: SessionTimelinePhase;
	error: string | null;
	optimistic: OptimisticOverlay;
}>;

export const emptySessionTimelineState = (): SessionTimelineState => ({
	projection: null,
	cursor: null,
	resetEpoch: null,
	appliedVersion: 0,
	phase: "empty",
	error: null,
	optimistic: { messages: {} },
});

export const restoreSessionTimelineState = (
	projection: SessionTimelineProjection | null,
	cursor: SessionStreamCursor | null,
): SessionTimelineState =>
	projection === null || cursor === null
		? emptySessionTimelineState()
		: {
				...emptySessionTimelineState(),
				projection,
				cursor,
				appliedVersion: cursor.version,
				phase: "cached",
			};

export const applySessionTimelineEvent = applyTimelineEvent;

/**
 * Records message changes made directly to the canonical cell by optimistic
 * command intent. The driver folds these back into its serialized reducer lane
 * before applying the next durable frame.
 */
export const observeOptimisticTimelineProjection = (
	state: SessionTimelineState,
	projection: SessionTimelineProjection,
): SessionTimelineState => {
	const previousById = new Map(
		(state.projection?.messages ?? []).map((message) => [message.id, message]),
	);
	const optimistic = { ...state.optimistic.messages };
	for (const message of projection.messages) {
		if (previousById.get(message.id) !== message)
			optimistic[message.id] = message;
	}
	return {
		...state,
		projection,
		optimistic: { messages: optimistic },
	};
};

const reconcileOptimisticMessages = (
	projection: SessionTimelineProjection,
	optimistic: OptimisticOverlay,
): Readonly<{
	projection: SessionTimelineProjection;
	optimistic: OptimisticOverlay;
}> => {
	const durableIds = new Set(projection.messages.map((message) => message.id));
	const retained = Object.values(optimistic.messages).filter(
		(message) => !durableIds.has(message.id),
	);
	const messages =
		retained.length === 0
			? projection.messages
			: [...projection.messages, ...retained];
	return {
		projection:
			messages === projection.messages
				? projection
				: SessionTimelineProjection.make({ ...projection, messages }),
		optimistic: {
			messages: Object.fromEntries(
				retained.map((message) => [message.id, message]),
			),
		},
	};
};

/** Prepends one older page without changing the durable event cursor. */
export const prependSessionTimelineMessages = (
	state: SessionTimelineState,
	messages: readonly Message[],
	olderMessageSequence: number | null,
): SessionTimelineState => {
	if (state.projection === null || messages.length === 0) {
		return state.projection === null
			? state
			: {
					...state,
					projection: SessionTimelineProjection.make({
						...state.projection,
						olderMessageSequence,
					}),
				};
	}
	const byId = new Map(
		[...messages, ...state.projection.messages].map((message) => [
			message.id,
			message,
		]),
	);
	return {
		...state,
		projection: SessionTimelineProjection.make({
			...state.projection,
			messages: [...byId.values()],
			olderMessageSequence,
		}),
	};
};

const cursorForFrame = (
	state: SessionTimelineState,
	version: number,
	cursor: SessionStreamCursor | undefined,
): SessionStreamCursor =>
	cursor ?? {
		epoch: state.cursor?.epoch ?? "legacy",
		version,
	};

const invalidCursorState = (
	state: SessionTimelineState,
	message: string,
): SessionTimelineState => ({
	...state,
	phase: "stale",
	error: message,
});

/** Projection and replay version advance in this one synchronous operation. */
export const reduceSessionTimelineFrame = (
	state: SessionTimelineState,
	frame: SessionTimelineFrame,
): SessionTimelineState => {
	if (state.phase === "deleted") return state;
	if (frame.kind === "snapshot") {
		const cursor = cursorForFrame(state, frame.throughVersion, frame.cursor);
		if (cursor.version !== frame.throughVersion) {
			return invalidCursorState(
				state,
				`Snapshot cursor ${cursor.version} does not match version ${frame.throughVersion}`,
			);
		}
		if (state.resetEpoch !== null && cursor.epoch !== state.resetEpoch) {
			return invalidCursorState(
				state,
				`Expected reset snapshot for epoch ${state.resetEpoch}, received ${cursor.epoch}`,
			);
		}
		if (
			state.resetEpoch === null &&
			state.cursor !== null &&
			cursor.epoch !== state.cursor.epoch
		) {
			return invalidCursorState(
				state,
				`Snapshot changed epoch from ${state.cursor.epoch} to ${cursor.epoch} without a reset`,
			);
		}
		if (
			state.resetEpoch === null &&
			state.cursor?.epoch === cursor.epoch &&
			cursor.version < state.cursor.version
		) {
			return state;
		}
		const reconciled = reconcileOptimisticMessages(
			SessionTimelineProjection.make({
				...frame.projection,
				olderMessageSequence:
					frame.olderMessageSequence ??
					frame.projection.olderMessageSequence ??
					null,
			}),
			state.optimistic,
		);
		return {
			...state,
			projection: reconciled.projection,
			optimistic: reconciled.optimistic,
			cursor,
			resetEpoch: null,
			appliedVersion: cursor.version,
			phase: "synchronizing",
			error: null,
		};
	}
	if (frame.kind === "synchronized") {
		const cursor = cursorForFrame(state, frame.throughVersion, frame.cursor);
		if (
			state.resetEpoch !== null ||
			state.projection === null ||
			state.cursor === null ||
			state.cursor.epoch !== cursor.epoch ||
			state.cursor.version < cursor.version ||
			cursor.version !== frame.throughVersion
		) {
			return invalidCursorState(
				state,
				`Synchronization through ${cursor.epoch}:${frame.throughVersion} arrived at ${state.cursor?.epoch ?? "none"}:${state.cursor?.version ?? 0}`,
			);
		}
		return { ...state, phase: "live", error: null };
	}
	if (frame.kind === "reset-required") {
		if (state.resetEpoch === frame.cursor.epoch) return state;
		return {
			...state,
			resetEpoch: frame.cursor.epoch,
			phase: "synchronizing",
			error: null,
		};
	}
	const cursor = cursorForFrame(state, frame.streamVersion, frame.cursor);
	if (cursor.version !== frame.streamVersion) {
		return invalidCursorState(
			state,
			`Event cursor ${cursor.version} does not match version ${frame.streamVersion}`,
		);
	}
	if (state.resetEpoch !== null) {
		return invalidCursorState(
			state,
			"Received an event before the required reset snapshot",
		);
	}
	if (state.cursor !== null && cursor.epoch !== state.cursor.epoch) {
		return invalidCursorState(
			state,
			`Event changed epoch from ${state.cursor.epoch} to ${cursor.epoch} without a reset`,
		);
	}
	if (
		state.cursor?.epoch === cursor.epoch &&
		cursor.version <= state.cursor.version
	) {
		return state;
	}
	if (state.projection === null) {
		return invalidCursorState(
			state,
			"Received an event without a retained projection",
		);
	}
	const expectedVersion = (state.cursor?.version ?? 0) + 1;
	if (frame.streamVersion !== expectedVersion) {
		return invalidCursorState(
			state,
			`Expected version ${expectedVersion}, received ${frame.streamVersion}`,
		);
	}
	const projection = applyTimelineEvent(state.projection, frame.event);
	const persistedMessageId =
		frame.event._tag === "MessagePersisted" ? frame.event.message.id : null;
	const optimistic =
		persistedMessageId !== null
			? {
					messages: Object.fromEntries(
						Object.entries(state.optimistic.messages).filter(
							([id]) => id !== persistedMessageId,
						),
					),
				}
			: state.optimistic;
	return {
		...state,
		projection,
		optimistic,
		cursor,
		appliedVersion: cursor.version,
		phase: state.phase === "live" ? "live" : "synchronizing",
		error: null,
	};
};
