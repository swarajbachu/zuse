import { Effect } from "effect";
import type { StoredEvent } from "../engine/dispatch.js";
import type { ProjectorDefinition } from "../engine/projector-runner.js";

export type SessionStatus =
	| "booting"
	| "idle"
	| "running"
	| "closed"
	| "error"
	| "deleted";

export type SessionReadRecord = {
	readonly sessionId: string;
	readonly chatId: string;
	readonly projectId: string;
	readonly title: string | null;
	readonly titleProvenance: "pending" | "automatic" | "manual";
	readonly status: SessionStatus;
	readonly providerId: string | null;
	readonly model: string | null;
	readonly cursor: string | null;
	readonly resumeStrategy: string | null;
	readonly runtimeMode: string | null;
	readonly agentsJson: string | null;
	readonly worktreeId: string | null;
	readonly forkedFromSessionId: string | null;
	readonly forkedFromMessageId: string | null;
	readonly permissionMode: string | null;
	readonly toolSearch: boolean;
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
	apply(event: StoredEvent): Effect.Effect<void>;
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
			return event.updatedAt;
		case "SessionModelSet":
		case "SessionProviderSet":
		case "SessionRuntimeModeSet":
		case "SessionPermissionModeSet":
		case "SessionWorktreeSet":
		case "SessionStatusSet":
		case "SessionResumeSet":
			return event.updatedAt;
		case "SessionArchived":
			return event.archivedAt;
		case "SessionUnarchived":
			return event.unarchivedAt;
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
		case "ProviderStopRequested":
			return event.requestedAt;
		case "ProviderDetached":
			return event.detachedAt;
	}
};

export class InMemorySessionReadModel
	implements SessionProjectionWriter, SessionReadRepository
{
	private readonly sessionRecords = new Map<string, SessionReadRecord>();
	private readonly messageRecords = new Map<string, MessageReadRecord>();
	private readonly appliedEventIds = new Set<string>();

	apply(record: StoredEvent): Effect.Effect<void> {
		return Effect.sync(() => {
			if (this.appliedEventIds.has(record.eventId)) return;
			const event = record.event;
			if (event._tag === "SessionCreated") {
				if (!this.sessionRecords.has(event.sessionId)) {
					this.sessionRecords.set(event.sessionId, {
						sessionId: event.sessionId,
						chatId: event.chatId,
						projectId: event.projectId,
						title: event.title ?? null,
						titleProvenance: event.titleProvenance ?? "manual",
						status: event.status ?? "idle",
						providerId: event.providerId ?? null,
						model: event.model ?? null,
						cursor: event.cursor ?? null,
						resumeStrategy: event.resumeStrategy ?? null,
						runtimeMode: event.runtimeMode ?? null,
						agentsJson: event.agentsJson ?? null,
						worktreeId: event.worktreeId ?? null,
						forkedFromSessionId: event.forkedFromSessionId ?? null,
						forkedFromMessageId: event.forkedFromMessageId ?? null,
						permissionMode: event.permissionMode ?? null,
						toolSearch: event.toolSearch ?? false,
						archivedAt: null,
						deletedAt: null,
						lastMessageAt: null,
						createdAt: event.createdAt,
						updatedAt: event.createdAt,
					});
				}
				this.appliedEventIds.add(record.eventId);
				return;
			}

			const session = this.sessionRecords.get(record.streamId);
			if (session === undefined) return;
			const timestamp = eventTimestamp(event);
			let next =
				timestamp === undefined
					? session
					: { ...session, updatedAt: Math.max(session.updatedAt, timestamp) };

			switch (event._tag) {
				case "SessionTitleSet":
					next = {
						...next,
						title: event.title,
						titleProvenance: event.titleProvenance ?? "manual",
					};
					break;
				case "SessionModelSet":
					next = { ...next, model: event.model };
					break;
				case "SessionProviderSet":
					next = {
						...next,
						providerId: event.providerId,
						model: event.model,
						cursor: null,
						resumeStrategy: "none",
					};
					break;
				case "SessionRuntimeModeSet":
					next = { ...next, runtimeMode: event.runtimeMode };
					break;
				case "SessionPermissionModeSet":
					next = { ...next, permissionMode: event.permissionMode };
					break;
				case "SessionWorktreeSet":
					next = {
						...next,
						worktreeId: event.worktreeId,
						cursor: null,
						resumeStrategy: "none",
					};
					break;
				case "SessionStatusSet":
					next = { ...next, status: event.status };
					break;
				case "SessionResumeSet":
					next = {
						...next,
						cursor: event.cursor,
						resumeStrategy: event.resumeStrategy,
					};
					break;
				case "SessionArchived":
					next = { ...next, archivedAt: event.archivedAt };
					break;
				case "SessionUnarchived":
					next = { ...next, archivedAt: null };
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
		});
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
