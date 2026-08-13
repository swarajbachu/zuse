import {
	DEFAULT_PERMISSION_MODE,
	DEFAULT_RUNTIME_MODE,
	QueuedMessage,
	QueueState,
	type SessionTimelineEvent,
	SessionTimelineProjection,
} from "@zuse/contracts";

/**
 * The one pure reducer for durable session-timeline state. This module is
 * intentionally browser-safe: SQL/domain adapters translate their records to
 * SessionTimelineEvent before calling it, and clients apply the same events.
 */
export const emptyTimelineProjection = (): SessionTimelineProjection =>
	SessionTimelineProjection.make({
		messages: [],
		olderMessageSequence: null,
		status: "idle",
		currentTurn: null,
		queue: QueueState.make({ items: [], paused: false }),
		permissionMode: DEFAULT_PERMISSION_MODE,
		runtimeMode: DEFAULT_RUNTIME_MODE,
	});

export const applyTimelineEvent = (
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
				queue: QueueState.make({
					...projection.queue,
					paused: event.paused,
				}),
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
				queue: QueueState.make({ ...projection.queue, items }),
			});
		}
		case "QueueUpdated":
			return SessionTimelineProjection.make({
				...projection,
				queue: QueueState.make({
					...projection.queue,
					items: projection.queue.items.map((item) =>
						item.id === event.queueId
							? QueuedMessage.make({
									...item,
									input: event.input,
									updatedAt: event.updatedAt,
									ready: event.ready,
								})
							: item,
					),
				}),
			});
		case "QueueRemoved":
			return SessionTimelineProjection.make({
				...projection,
				queue: QueueState.make({
					...projection.queue,
					items: projection.queue.items.filter(
						(item) => item.id !== event.queueId,
					),
				}),
			});
		case "QueueReordered": {
			const positions = new Map(
				event.queueIds.map((queueId, position) => [queueId, position]),
			);
			const items = projection.queue.items
				.map((item) =>
					QueuedMessage.make({
						...item,
						position: positions.get(item.id) ?? item.position,
					}),
				)
				.sort((left, right) => left.position - right.position);
			return SessionTimelineProjection.make({
				...projection,
				queue: QueueState.make({ ...projection.queue, items }),
			});
		}
		case "Noop":
			return projection;
	}
};
