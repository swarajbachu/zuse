import {
	AgentTurnId,
	ComposerInput,
	Message,
	MessageContent,
	MessageId,
	MessageRole,
	QueuedMessage,
	type SessionId,
	type SessionTimelineEvent,
} from "@zuse/contracts";
import { Result, Schema } from "effect";
import type { SessionEvent as SessionDomainEvent } from "../core/events.js";

export {
	applyTimelineEvent,
	emptyTimelineProjection,
} from "./timeline-reducer.js";

const decodeContent = Schema.decodeUnknownResult(
	Schema.fromJsonString(MessageContent),
);
const decodeRole = Schema.decodeUnknownResult(MessageRole);
const decodeComposerInput = Schema.decodeUnknownResult(
	Schema.fromJsonString(ComposerInput),
);

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
