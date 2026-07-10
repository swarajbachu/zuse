import {
	Message,
	MessageContent,
	MessageId,
	MessageRole,
	type SessionDomainEventEnvelope,
	SessionStatus,
} from "@zuse/contracts";
import { Result, Schema } from "effect";

const MessagePersisted = Schema.fromJsonString(
	Schema.TaggedStruct("MessagePersisted", {
		messageId: Schema.String,
		role: MessageRole,
		contentJson: Schema.String,
		createdAt: Schema.Number,
	}),
);

const SessionStatusSet = Schema.fromJsonString(
	Schema.TaggedStruct("SessionStatusSet", {
		status: SessionStatus,
	}),
);

export type SessionEventProjection =
	| { readonly _tag: "message"; readonly message: Message }
	| { readonly _tag: "status"; readonly status: typeof SessionStatus.Type }
	| { readonly _tag: "other" };

class SessionEventCursorRegistry {
	private readonly cursors = new Map<string, number>();

	get(key: string): number | undefined {
		return this.cursors.get(key);
	}

	set(key: string, sequence: number): void {
		const current = this.cursors.get(key) ?? 0;
		if (sequence > current) this.cursors.set(key, sequence);
	}

	delete(key: string): void {
		this.cursors.delete(key);
	}
}

/** Shared monotonic cursor owner used by renderer and mobile stream adapters. */
export const sessionEventCursors = new SessionEventCursorRegistry();

/**
 * Decode the client-facing projections of a durable session event. Unknown
 * event types remain visible as `other`, allowing consumers to advance their
 * replay cursor without coupling UI state to every domain event.
 */
export const projectSessionEvent = (
	envelope: SessionDomainEventEnvelope,
): SessionEventProjection => {
	if (envelope.type === "MessagePersisted") {
		const payload = Schema.decodeUnknownResult(MessagePersisted)(
			envelope.payloadJson,
		);
		if (Result.isFailure(payload)) return { _tag: "other" };
		const content = Schema.decodeUnknownResult(
			Schema.fromJsonString(MessageContent),
		)(payload.success.contentJson);
		if (Result.isFailure(content)) return { _tag: "other" };
		return {
			_tag: "message",
			message: Message.make({
				id: MessageId.make(payload.success.messageId),
				sessionId: envelope.sessionId,
				role: payload.success.role,
				content: content.success,
				createdAt: new Date(payload.success.createdAt),
			}),
		};
	}

	if (envelope.type === "SessionStatusSet") {
		const payload = Schema.decodeUnknownResult(SessionStatusSet)(
			envelope.payloadJson,
		);
		if (Result.isSuccess(payload)) {
			return { _tag: "status", status: payload.success.status };
		}
	}

	return { _tag: "other" };
};
