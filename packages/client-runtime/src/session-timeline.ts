import {
	SessionTimelineProjection,
	type Message,
	type SessionId,
	type SessionTimelineEvent,
	type SessionTimelineFrame,
} from "@zuse/contracts";

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
	appliedVersion: number;
	phase: SessionTimelinePhase;
	error: string | null;
	optimistic: OptimisticOverlay;
}>;

export const emptySessionTimelineState = (): SessionTimelineState => ({
	projection: null,
	appliedVersion: 0,
	phase: "empty",
	error: null,
	optimistic: { messages: {} },
});

export const applySessionTimelineEvent = (
	projection: SessionTimelineProjection,
	event: SessionTimelineEvent,
): SessionTimelineProjection => {
	switch (event._tag) {
		case "MessagePersisted": {
			const index = projection.messages.findIndex(
				(message) => message.id === event.message.id,
			);
			const messages = [...projection.messages];
			if (index === -1) messages.push(event.message);
			else messages[index] = event.message;
			return SessionTimelineProjection.make({ ...projection, messages });
		}
		case "StatusSet":
			return SessionTimelineProjection.make({
				...projection,
				status: event.status,
			});
		case "TurnStarted":
			return SessionTimelineProjection.make({
				...projection,
				currentTurn: { turnId: event.turnId, phase: event.phase },
			});
		case "TurnPhaseSet":
			return projection.currentTurn?.turnId === event.turnId
				? SessionTimelineProjection.make({
						...projection,
						currentTurn: { turnId: event.turnId, phase: event.phase },
					})
				: projection;
		case "TurnSettled":
			return projection.currentTurn?.turnId === event.turnId
				? SessionTimelineProjection.make({
						...projection,
						currentTurn: null,
					})
				: projection;
		case "PermissionModeSet":
			return SessionTimelineProjection.make({
				...projection,
				permissionMode: event.permissionMode,
			});
		case "RuntimeModeSet":
			return SessionTimelineProjection.make({
				...projection,
				runtimeMode: event.runtimeMode,
			});
		case "QueuePausedSet":
			return SessionTimelineProjection.make({
				...projection,
				queue: { ...projection.queue, paused: event.paused },
			});
		case "QueueEnqueued": {
			const existing = projection.queue.items.findIndex(
				(item) => item.id === event.item.id,
			);
			const items = [...projection.queue.items];
			if (existing === -1) items.push(event.item);
			else items[existing] = event.item;
			items.sort((left, right) => left.position - right.position);
			return SessionTimelineProjection.make({
				...projection,
				queue: { ...projection.queue, items },
			});
		}
		case "QueueUpdated":
			return SessionTimelineProjection.make({
				...projection,
				queue: {
					...projection.queue,
					items: projection.queue.items.map((item) =>
						item.id === event.queueId
							? {
									...item,
									input: event.input,
									updatedAt: event.updatedAt,
									ready: event.ready,
								}
							: item,
					),
				},
			});
		case "QueueRemoved":
			return SessionTimelineProjection.make({
				...projection,
				queue: {
					...projection.queue,
					items: projection.queue.items.filter(
						(item) => item.id !== event.queueId,
					),
				},
			});
		case "QueueReordered": {
			const positions = new Map(
				event.queueIds.map((queueId, position) => [queueId, position]),
			);
			const items = projection.queue.items
				.map((item) => ({
					...item,
					position: positions.get(item.id) ?? item.position,
				}))
				.sort((left, right) => left.position - right.position);
			return SessionTimelineProjection.make({
				...projection,
				queue: { ...projection.queue, items },
			});
		}
		case "Noop":
			return projection;
	}
};

/** Projection and replay version advance in this one synchronous operation. */
export const reduceSessionTimelineFrame = (
	state: SessionTimelineState,
	frame: SessionTimelineFrame,
): SessionTimelineState => {
	if (state.phase === "deleted") return state;
	if (frame.kind === "snapshot") {
		return {
			...state,
			projection: frame.projection,
			appliedVersion: frame.throughVersion,
			phase: "synchronizing",
			error: null,
		};
	}
	if (frame.kind === "synchronized") {
		if (
			state.projection === null ||
			state.appliedVersion < frame.throughVersion
		) {
			return {
				...state,
				phase: "stale",
				error: `Synchronization through version ${frame.throughVersion} arrived at ${state.appliedVersion}`,
			};
		}
		return { ...state, phase: "live", error: null };
	}
	if (frame.streamVersion <= state.appliedVersion) return state;
	if (state.projection === null) {
		return {
			...state,
			phase: "stale",
			error: "Received an event without a retained projection",
		};
	}
	const expectedVersion = state.appliedVersion + 1;
	if (frame.streamVersion !== expectedVersion) {
		return {
			...state,
			phase: "stale",
			error: `Expected version ${expectedVersion}, received ${frame.streamVersion}`,
		};
	}
	return {
		...state,
		projection: applySessionTimelineEvent(state.projection, frame.event),
		appliedVersion: frame.streamVersion,
		phase: state.phase === "live" ? "live" : "synchronizing",
		error: null,
	};
};

type Entry = {
	state: SessionTimelineState;
	retainers: number;
	listeners: Set<(state: SessionTimelineState) => void>;
	eviction: ReturnType<typeof setTimeout> | null;
};

/**
 * Keyed retained state independent of component mount lifetime. Transport
 * adapters feed frames with `accept`; React and native adapters only observe.
 */
export class SessionTimelineRegistry {
	private readonly entries = new Map<string, Entry>();

	constructor(private readonly idleTtlMs = 5 * 60_000) {}

	private entry(sessionId: SessionId): Entry {
		const existing = this.entries.get(sessionId);
		if (existing !== undefined) return existing;
		const created: Entry = {
			state: emptySessionTimelineState(),
			retainers: 0,
			listeners: new Set(),
			eviction: null,
		};
		this.entries.set(sessionId, created);
		return created;
	}

	retain(sessionId: SessionId): () => void {
		const entry = this.entry(sessionId);
		entry.retainers += 1;
		if (entry.eviction !== null) clearTimeout(entry.eviction);
		entry.eviction = null;
		if (entry.state.phase === "cached" || entry.state.phase === "stale") {
			entry.state = { ...entry.state, phase: "synchronizing" };
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			entry.retainers = Math.max(0, entry.retainers - 1);
			if (entry.retainers > 0 || entry.state.projection?.currentTurn != null) {
				return;
			}
			entry.state = { ...entry.state, phase: "cached" };
			entry.eviction = setTimeout(() => {
				if (entry.retainers === 0) this.entries.delete(sessionId);
			}, this.idleTtlMs);
		};
	}

	state(sessionId: SessionId): SessionTimelineState {
		return this.entry(sessionId).state;
	}

	accept(sessionId: SessionId, frame: SessionTimelineFrame): void {
		const entry = this.entry(sessionId);
		const next = reduceSessionTimelineFrame(entry.state, frame);
		if (next === entry.state) return;
		entry.state = next;
		for (const listener of entry.listeners) listener(next);
	}

	subscribe(
		sessionId: SessionId,
		listener: (state: SessionTimelineState) => void,
	): () => void {
		const entry = this.entry(sessionId);
		entry.listeners.add(listener);
		return () => entry.listeners.delete(listener);
	}

	delete(sessionId: SessionId): void {
		const entry = this.entries.get(sessionId);
		if (entry?.eviction != null) clearTimeout(entry.eviction);
		if (entry !== undefined) {
			entry.state = { ...emptySessionTimelineState(), phase: "deleted" };
			for (const listener of entry.listeners) listener(entry.state);
		}
		this.entries.delete(sessionId);
	}

	shutdown(): void {
		for (const entry of this.entries.values()) {
			if (entry.eviction !== null) clearTimeout(entry.eviction);
		}
		this.entries.clear();
	}
}
