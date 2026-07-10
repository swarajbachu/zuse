import type { StoredEvent } from "../engine/dispatch.js";
import type { ProjectorDefinition } from "../engine/projector-runner.js";

export type SessionStatus = "idle" | "running" | "deleted";

export type SessionReadRecord = {
	readonly sessionId: string;
	readonly chatId: string;
	readonly projectId: string;
	readonly title: string | null;
	readonly status: SessionStatus;
	readonly providerId: string | null;
	readonly archivedAt: number | null;
	readonly deletedAt: number | null;
	readonly lastMessageAt: number | null;
	readonly createdAt: number;
	readonly updatedAt: number;
};

export type MessageReadRecord = {
	readonly messageId: string;
	readonly sessionId: string;
	readonly turnId: string | null;
	readonly role: string;
	readonly kind: string;
	readonly contentJson: string;
	readonly parentItemId: string | null;
	readonly createdAt: number;
	readonly sequence: number;
};

export interface SessionProjectionWriter {
	apply(event: StoredEvent): PromiseLike<void> | void;
}

export interface SessionReadRepository {
	session(sessionId: string): SessionReadRecord | null;
	sessions(): readonly SessionReadRecord[];
	messages(sessionId: string): readonly MessageReadRecord[];
}

export const makeSessionReadModelProjector = (
	writer: SessionProjectionWriter,
): ProjectorDefinition<StoredEvent> => ({
	name: "session-read-model",
	sequenceOf: (event) => event.sequence,
	apply: (event) => writer.apply(event),
});

const eventTimestamp = (event: StoredEvent["event"]): number | undefined => {
	switch (event._tag) {
		case "SessionCreated":
			return event.createdAt;
		case "SessionTitleSet":
			return undefined;
		case "SessionArchived":
			return event.archivedAt;
		case "SessionDeleted":
			return event.deletedAt;
		case "TurnStarted":
			return event.startedAt;
		case "TurnSettled":
			return event.settledAt;
		case "MessagePersisted":
			return event.createdAt;
		case "SegmentOpened":
			return event.openedAt;
		case "SegmentSettled":
			return event.settledAt;
		case "PermissionRequested":
			return event.requestedAt;
		case "PermissionResolved":
			return event.resolvedAt;
		case "ProviderAttached":
			return event.attachedAt;
		case "ProviderDetached":
			return event.detachedAt;
		case "CheckpointRecorded":
			return event.recordedAt;
		case "WorktreeArchiveRequested":
			return event.requestedAt;
	}
};

export class InMemorySessionReadModel
	implements SessionProjectionWriter, SessionReadRepository
{
	private readonly sessionRecords = new Map<string, SessionReadRecord>();
	private readonly messageRecords = new Map<string, MessageReadRecord>();
	private readonly appliedEventIds = new Set<string>();

	apply(record: StoredEvent): Promise<void> {
		if (this.appliedEventIds.has(record.eventId)) return Promise.resolve();
		const event = record.event;
		if (event._tag === "SessionCreated") {
			if (!this.sessionRecords.has(event.sessionId)) {
				this.sessionRecords.set(event.sessionId, {
					sessionId: event.sessionId,
					chatId: event.chatId,
					projectId: event.projectId,
					title: null,
					status: "idle",
					providerId: null,
					archivedAt: null,
					deletedAt: null,
					lastMessageAt: null,
					createdAt: event.createdAt,
					updatedAt: event.createdAt,
				});
			}
			this.appliedEventIds.add(record.eventId);
			return Promise.resolve();
		}

		const session = this.sessionRecords.get(record.streamId);
		if (session === undefined) return Promise.resolve();
		const timestamp = eventTimestamp(event);
		let next =
			timestamp === undefined
				? session
				: { ...session, updatedAt: Math.max(session.updatedAt, timestamp) };

		switch (event._tag) {
			case "SessionTitleSet":
				next = { ...next, title: event.title };
				break;
			case "SessionArchived":
				next = { ...next, archivedAt: event.archivedAt };
				break;
			case "SessionDeleted":
				next = {
					...next,
					deletedAt: event.deletedAt,
					status: "deleted",
				};
				break;
			case "TurnStarted":
				next = { ...next, status: "running" };
				break;
			case "TurnSettled":
				next = { ...next, status: "idle" };
				break;
			case "MessagePersisted":
				if (!this.messageRecords.has(event.messageId)) {
					this.messageRecords.set(event.messageId, {
						messageId: event.messageId,
						sessionId: record.streamId,
						turnId: event.turnId,
						role: event.role,
						kind: event.kind,
						contentJson: event.contentJson,
						parentItemId: event.parentItemId,
						createdAt: event.createdAt,
						sequence: record.sequence,
					});
				}
				next = { ...next, lastMessageAt: event.createdAt };
				break;
			case "ProviderAttached":
				next = { ...next, providerId: event.providerId };
				break;
			case "ProviderDetached":
				next = { ...next, providerId: null };
				break;
			default:
				break;
		}

		this.sessionRecords.set(record.streamId, next);
		this.appliedEventIds.add(record.eventId);
		return Promise.resolve();
	}

	session(sessionId: string): SessionReadRecord | null {
		return this.sessionRecords.get(sessionId) ?? null;
	}

	sessions(): readonly SessionReadRecord[] {
		return [...this.sessionRecords.values()];
	}

	messages(sessionId: string): readonly MessageReadRecord[] {
		return [...this.messageRecords.values()]
			.filter((message) => message.sessionId === sessionId)
			.sort((left, right) => left.sequence - right.sequence);
	}
}
