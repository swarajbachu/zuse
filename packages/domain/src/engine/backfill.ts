import type {
	PermissionMode,
	ResumeStrategy,
	RuntimeMode,
	SessionStatus,
} from "@zuse/contracts";
import type { SessionEvent } from "../core/events.js";

export type LegacySessionSnapshot = {
	readonly sessionId: string;
	readonly chatId: string;
	readonly projectId: string;
	readonly title: string;
	readonly providerId: string;
	readonly model: string;
	readonly status: SessionStatus;
	readonly cursor: string | null;
	readonly resumeStrategy: ResumeStrategy;
	readonly runtimeMode: RuntimeMode;
	readonly agentsJson: string | null;
	readonly worktreeId: string | null;
	readonly forkedFromSessionId: string | null;
	readonly forkedFromMessageId: string | null;
	readonly permissionMode: PermissionMode;
	readonly toolSearch: boolean;
	readonly queuePaused: boolean;
	readonly createdAt: number;
	readonly updatedAt: number;
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

export const sessionCreatedEventFromSnapshot = (
	session: LegacySessionSnapshot,
): SessionEvent => ({
	_tag: "SessionCreated",
	sessionId: session.sessionId,
	chatId: session.chatId,
	projectId: session.projectId,
	title: session.title,
	providerId: session.providerId,
	model: session.model,
	status: session.status,
	cursor: session.cursor,
	resumeStrategy: session.resumeStrategy,
	runtimeMode: session.runtimeMode,
	agentsJson: session.agentsJson,
	worktreeId: session.worktreeId,
	forkedFromSessionId: session.forkedFromSessionId,
	forkedFromMessageId: session.forkedFromMessageId,
	permissionMode: session.permissionMode,
	toolSearch: session.toolSearch,
	queuePaused: session.queuePaused,
	createdAt: session.createdAt,
});

export const messageEventFromSnapshot = (
	message: LegacyMessageSnapshot,
): SessionEvent => ({
	_tag: "MessagePersisted",
	messageId: message.messageId,
	turnId: null,
	role: message.role,
	kind: message.kind,
	contentJson: message.contentJson,
	parentItemId: message.parentItemId,
	createdAt: message.createdAt,
});

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
			sessionCreatedEventFromSnapshot(session),
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
				messageEventFromSnapshot(message),
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
		append(
			session.sessionId,
			id("session-title", session.sessionId),
			session.updatedAt,
			{
				_tag: "SessionTitleSet",
				title: session.title,
				updatedAt: session.updatedAt,
			},
		);
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
