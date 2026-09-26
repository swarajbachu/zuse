import {
	DEFAULT_PERMISSION_MODE,
	DEFAULT_RUNTIME_MODE,
	QueuedMessage,
	QueueState,
	type SessionInteraction,
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
		interactions: [],
	});

const upsertInteraction = (
	interactions: ReadonlyArray<SessionInteraction>,
	interaction: SessionInteraction,
): ReadonlyArray<SessionInteraction> => {
	const index = interactions.findIndex(
		(existing) =>
			existing._tag === interaction._tag && existing.id === interaction.id,
	);
	if (index === -1) return [...interactions, interaction];
	const next = [...interactions];
	next[index] = interaction;
	return next;
};

const removeInteraction = (
	interactions: ReadonlyArray<SessionInteraction>,
	tag: SessionInteraction["_tag"],
	id: string,
): ReadonlyArray<SessionInteraction> =>
	interactions.filter(
		(interaction) => interaction._tag !== tag || interaction.id !== id,
	);

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
			const content = event.message.content;
			const interactions = (() => {
				if (content._tag === "user_question") {
					return upsertInteraction(projection.interactions, {
						_tag: "Question",
						id: content.itemId,
						questions: content.questions,
						requestedAt: event.message.createdAt,
					});
				}
				if (content._tag === "user_question_answer") {
					return removeInteraction(
						projection.interactions,
						"Question",
						content.itemId,
					);
				}
				return projection.interactions;
			})();
			return SessionTimelineProjection.make({
				...projection,
				messages,
				interactions,
			});
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
			// Settlement is the authoritative terminal transition for a turn. Keep
			// the live reducer identical to the SQLite projector: otherwise a client
			// can clear currentTurn while retaining status="running" until remount.
			return SessionTimelineProjection.make({
				...projection,
				status: "idle",
				currentTurn: null,
			});
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
		case "PermissionRequested":
			return SessionTimelineProjection.make({
				...projection,
				interactions: upsertInteraction(projection.interactions, {
					_tag: "Permission",
					id: event.request.id,
					request: event.request,
				}),
			});
		case "PermissionResolved":
			return SessionTimelineProjection.make({
				...projection,
				interactions: removeInteraction(
					projection.interactions,
					"Permission",
					event.requestId,
				),
			});
		case "QuestionResolved":
			return SessionTimelineProjection.make({
				...projection,
				interactions: removeInteraction(
					projection.interactions,
					"Question",
					event.itemId,
				),
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
