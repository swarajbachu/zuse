import type { SessionEvent } from "../core/events.js";

export type LegacySessionSnapshot = {
	readonly sessionId: string;
	readonly chatId: string;
	readonly projectId: string;
	readonly title: string;
	readonly createdAt: number;
	readonly archivedAt: number | null;
	readonly deletedAt: number | null;
};

export type LegacyMessageSnapshot = {
	readonly rowId: number;
	readonly messageId: string;
	readonly sessionId: string;
	readonly role: string;
	readonly kind: string;
	readonly contentJson: string;
	readonly parentItemId: string | null;
	readonly createdAt: number;
};

export type BackfillInput = {
	readonly sessions: readonly LegacySessionSnapshot[];
	readonly messages: readonly LegacyMessageSnapshot[];
	readonly existingEventIds: ReadonlySet<string>;
	readonly existingMessageIds: ReadonlySet<string>;
};

export type BackfillEvent = {
	readonly eventId: string;
	readonly correlationId: string;
	readonly streamId: string;
	readonly occurredAt: number;
	readonly actor: "backfill";
	readonly event: SessionEvent;
};

const id = (kind: string, entityId: string): string =>
	`backfill:${kind}:${entityId}`;

export const synthesizeBackfill = (
	input: BackfillInput,
): readonly BackfillEvent[] => {
	const output: BackfillEvent[] = [];
	const messagesBySession = new Map<string, LegacyMessageSnapshot[]>();
	for (const message of input.messages) {
		const existing = messagesBySession.get(message.sessionId);
		if (existing === undefined) {
			messagesBySession.set(message.sessionId, [message]);
		} else {
			existing.push(message);
		}
	}

	const append = (
		streamId: string,
		eventId: string,
		occurredAt: number,
		event: SessionEvent,
	): void => {
		if (input.existingEventIds.has(eventId)) return;
		output.push({
			eventId,
			correlationId: eventId,
			streamId,
			occurredAt,
			actor: "backfill",
			event,
		});
	};

	const sessions = [...input.sessions].sort(
		(left, right) =>
			left.createdAt - right.createdAt ||
			left.sessionId.localeCompare(right.sessionId),
	);
	for (const session of sessions) {
		append(
			session.sessionId,
			id("session-created", session.sessionId),
			session.createdAt,
			{
				_tag: "SessionCreated",
				sessionId: session.sessionId,
				chatId: session.chatId,
				projectId: session.projectId,
				createdAt: session.createdAt,
			},
		);
		append(
			session.sessionId,
			id("session-title", session.sessionId),
			session.createdAt,
			{ _tag: "SessionTitleSet", title: session.title },
		);

		const messages = [...(messagesBySession.get(session.sessionId) ?? [])].sort(
			(left, right) =>
				left.createdAt - right.createdAt || left.rowId - right.rowId,
		);
		for (const message of messages) {
			if (input.existingMessageIds.has(message.messageId)) continue;
			append(
				session.sessionId,
				id("message", message.messageId),
				message.createdAt,
				{
					_tag: "MessagePersisted",
					messageId: message.messageId,
					turnId: null,
					role: message.role,
					kind: message.kind,
					contentJson: message.contentJson,
					parentItemId: message.parentItemId,
					createdAt: message.createdAt,
				},
			);
		}

		if (session.archivedAt !== null) {
			append(
				session.sessionId,
				id("session-archived", session.sessionId),
				session.archivedAt,
				{ _tag: "SessionArchived", archivedAt: session.archivedAt },
			);
		}
		if (session.deletedAt !== null) {
			append(
				session.sessionId,
				id("session-deleted", session.sessionId),
				session.deletedAt,
				{ _tag: "SessionDeleted", deletedAt: session.deletedAt },
			);
		}
	}

	return output;
};
