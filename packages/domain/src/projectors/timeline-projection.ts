import {
	AgentTurnId,
	ComposerInput,
	DEFAULT_PERMISSION_MODE,
	DEFAULT_RUNTIME_MODE,
	Message,
	MessageContent,
	MessageId,
	MessageRole,
	QueuedMessage,
	QueueState,
	type SessionId,
	type SessionTimelineEvent,
	SessionTimelineProjection,
} from "@zuse/contracts";
import { Result, Schema } from "effect";
import {
	type SessionEvent as SessionDomainEvent,
	SessionEvent,
} from "../core/events.js";
import type { StoredEvent } from "../engine/dispatch.js";

const decodeContent = Schema.decodeUnknownResult(
	Schema.fromJsonString(MessageContent),
);
const decodeRole = Schema.decodeUnknownResult(MessageRole);
const decodeComposerInput = Schema.decodeUnknownResult(
	Schema.fromJsonString(ComposerInput),
);

export const emptyTimelineProjection = (): SessionTimelineProjection =>
	SessionTimelineProjection.make({
		messages: [],
		status: "idle",
		currentTurn: null,
		queue: QueueState.make({ items: [], paused: false }),
		permissionMode: DEFAULT_PERMISSION_MODE,
		runtimeMode: DEFAULT_RUNTIME_MODE,
	});

export const timelineEventFromDomain = (
	sessionId: SessionId,
	event: SessionDomainEvent,
): SessionTimelineEvent => {
	switch (event._tag) {
		case "MessagePersisted": {
			const content = decodeContent(event.contentJson);
			const role = decodeRole(event.role);
			if (Result.isFailure(content) || Result.isFailure(role)) {
				return { _tag: "Noop" };
			}
			return {
				_tag: "MessagePersisted",
				message: Message.make({
					id: MessageId.make(event.messageId),
					sessionId,
					role: role.success,
					content: content.success,
					createdAt: new Date(event.createdAt),
				}),
			};
		}
		case "SessionStatusSet":
			return { _tag: "StatusSet", status: event.status };
		case "TurnStarted":
			return {
				_tag: "TurnStarted",
				turnId: AgentTurnId.make(event.turnId),
				phase: "running",
			};
		case "TurnInterruptRequested":
			return {
				_tag: "TurnPhaseSet",
				turnId: AgentTurnId.make(event.turnId),
				phase: "interrupt-requested",
			};
		case "TurnInterruptAcknowledged":
			return {
				_tag: "TurnPhaseSet",
				turnId: AgentTurnId.make(event.turnId),
				phase: "interrupt-acknowledged",
			};
		case "TurnInterruptFailed":
			return {
				_tag: "TurnPhaseSet",
				turnId: AgentTurnId.make(event.turnId),
				phase: "running",
			};
		case "TurnSettled":
			return {
				_tag: "TurnSettled",
				turnId: AgentTurnId.make(event.turnId),
				outcome: event.outcome,
			};
		case "SessionPermissionModeSet":
			return {
				_tag: "PermissionModeSet",
				permissionMode: event.permissionMode,
			};
		case "SessionRuntimeModeSet":
			return { _tag: "RuntimeModeSet", runtimeMode: event.runtimeMode };
		case "SessionQueuePausedSet":
			return { _tag: "QueuePausedSet", paused: event.paused };
		case "QueuedTurnEnqueued": {
			const input = decodeComposerInput(event.inputJson);
			return Result.isFailure(input)
				? { _tag: "Noop" }
				: {
						_tag: "QueueEnqueued",
						item: QueuedMessage.make({
							id: event.queueId,
							sessionId,
							input: input.success,
							position: event.position,
							createdAt: new Date(event.createdAt),
							updatedAt: new Date(event.createdAt),
							ready: event.ready,
						}),
					};
		}
		case "QueuedTurnUpdated": {
			const input = decodeComposerInput(event.inputJson);
			return Result.isFailure(input)
				? { _tag: "Noop" }
				: {
						_tag: "QueueUpdated",
						queueId: event.queueId,
						input: input.success,
						updatedAt: new Date(event.updatedAt),
						ready: event.ready,
					};
		}
		case "QueuedTurnRemoved":
		case "QueuedTurnClaimed":
			return { _tag: "QueueRemoved", queueId: event.queueId };
		case "QueuedTurnsReordered":
			return { _tag: "QueueReordered", queueIds: event.queueIds };
		default:
			return { _tag: "Noop" };
	}
};

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
		case "QueueEnqueued":
			return projection.queue.items.some((item) => item.id === event.item.id)
				? projection
				: SessionTimelineProjection.make({
						...projection,
						queue: QueueState.make({
							...projection.queue,
							items: [...projection.queue.items, event.item],
						}),
					});
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
			const byId = new Map(
				projection.queue.items.map((item) => [item.id, item]),
			);
			const ordered = event.queueIds.flatMap((id, position) => {
				const item = byId.get(id);
				return item === undefined
					? []
					: [QueuedMessage.make({ ...item, position })];
			});
			return SessionTimelineProjection.make({
				...projection,
				queue: QueueState.make({ ...projection.queue, items: ordered }),
			});
		}
		case "Noop":
			return projection;
	}
};

export const timelineSnapshotFromEvents = (
	sessionId: SessionId,
	records: readonly StoredEvent[],
): SessionTimelineProjection => {
	let projection = emptyTimelineProjection();
	for (const record of records) {
		const domainEvent = record.event;
		if (domainEvent._tag === "SessionCreated") {
			projection = SessionTimelineProjection.make({
				...projection,
				status: domainEvent.status ?? projection.status,
				permissionMode: domainEvent.permissionMode ?? projection.permissionMode,
				runtimeMode: domainEvent.runtimeMode ?? projection.runtimeMode,
				queue: QueueState.make({
					...projection.queue,
					paused: domainEvent.queuePaused ?? projection.queue.paused,
				}),
			});
		}
		projection = applyTimelineEvent(
			projection,
			timelineEventFromDomain(sessionId, domainEvent),
		);
	}
	return projection;
};

export type SerializedSessionEvent = {
	readonly payloadJson: string;
};

/** Browser-safe projection for encrypted-history records after decryption. */
export const timelineSnapshotFromSerializedEvents = (
	sessionId: SessionId,
	records: readonly SerializedSessionEvent[],
): SessionTimelineProjection => {
	let projection = emptyTimelineProjection();
	for (const record of records) {
		let payload: unknown;
		try {
			payload = JSON.parse(record.payloadJson);
		} catch {
			continue;
		}
		const decoded = Schema.decodeUnknownResult(SessionEvent)(payload);
		if (Result.isFailure(decoded)) continue;
		const event = decoded.success;
		if (event._tag === "SessionCreated") {
			projection = SessionTimelineProjection.make({
				...projection,
				status: event.status ?? projection.status,
				permissionMode: event.permissionMode ?? projection.permissionMode,
				runtimeMode: event.runtimeMode ?? projection.runtimeMode,
				queue: QueueState.make({
					...projection.queue,
					paused: event.queuePaused ?? projection.queue.paused,
				}),
			});
		}
		projection = applyTimelineEvent(
			projection,
			timelineEventFromDomain(sessionId, event),
		);
	}
	return projection;
};
