import {
	PermissionMode,
	ResumeStrategy,
	RuntimeMode,
	SessionStatus,
} from "@zuse/contracts";
import type { ChatEvent } from "@zuse/domain/chat/events";
import {
	messageEventFromSnapshot,
	sessionCreatedEventFromSnapshot,
	synthesizeBackfill,
} from "@zuse/domain/engine/backfill";
import { DateTime, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

const BACKFILL_NAME = "conversation-lifecycle-v5";
const PROJECTORS = [
	"messages",
	"session-read-model",
	"chat-read-model",
	"reactor:auto-name-chat",
	"reactor:permission-lifecycle",
	"reactor:provider-start",
	"reactor:provider-stop",
	"reactor:chat-archive",
	"reactor:chat-delete",
] as const;

interface ChatRow {
	readonly id: string;
	readonly project_id: string;
	readonly worktree_id: string | null;
	readonly title: string;
	readonly active_session_id: string | null;
	readonly origin_session_id: string | null;
	readonly archived_at: string | null;
	readonly archived_worktree_json: string | null;
	readonly last_read_at: string | null;
	readonly created_at: string;
	readonly updated_at: string;
}

interface SessionRow {
	readonly id: string;
	readonly chat_id: string;
	readonly project_id: string;
	readonly title: string;
	readonly provider_id: string;
	readonly model: string;
	readonly status: string;
	readonly cursor: string | null;
	readonly resume_strategy: string;
	readonly runtime_mode: string;
	readonly agents_json: string | null;
	readonly worktree_id: string | null;
	readonly forked_from_session_id: string | null;
	readonly forked_from_message_id: string | null;
	readonly permission_mode: string;
	readonly tool_search: number;
	readonly queue_paused: number;
	readonly created_at: string;
	readonly updated_at: string;
	readonly archived_at: string | null;
}

interface MessageRow {
	readonly row_id: number;
	readonly id: string;
	readonly session_id: string;
	readonly role: string;
	readonly kind: string;
	readonly content_json: string;
	readonly parent_item_id: string | null;
	readonly created_at: string;
}

interface ExistingEventRow {
	readonly event_id: string;
	readonly stream_kind: string;
	readonly stream_id: string;
	readonly type: string;
	readonly message_id: string | null;
}

interface StreamVersionRow {
	readonly stream_id: string;
	readonly stream_version: number;
}

interface BackfillMarkerRow {
	readonly status: "running" | "completed";
	readonly event_count: number;
}

interface ChatBackfillEvent {
	readonly eventId: string;
	readonly streamId: string;
	readonly occurredAt: number;
	readonly event: ChatEvent;
}

export type LifecycleBackfillResult = {
	readonly status: "completed" | "already-completed";
	readonly eventCount: number;
};

const timestamp = (value: string | null, field: string): number | null => {
	if (value === null) return null;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) {
		throw new Error(`invalid ${field} timestamp: ${value}`);
	}
	return parsed;
};

const requiredTimestamp = (value: string, field: string): number => {
	const parsed = timestamp(value, field);
	if (parsed === null) throw new Error(`missing ${field} timestamp`);
	return parsed;
};

const decodeSessionStatus = Schema.decodeUnknownEffect(SessionStatus);
const decodeResumeStrategy = Schema.decodeUnknownEffect(ResumeStrategy);
const decodeRuntimeMode = Schema.decodeUnknownEffect(RuntimeMode);
const decodePermissionMode = Schema.decodeUnknownEffect(PermissionMode);

export const runLifecycleBackfill = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	return yield* sql.withTransaction(
		Effect.gen(function* () {
			const markers = yield* sql<BackfillMarkerRow>`
				SELECT status, event_count FROM backfill_runs
				WHERE backfill_name = ${BACKFILL_NAME}
			`;
			const completed = markers.find((marker) => marker.status === "completed");
			if (completed !== undefined) {
				return {
					status: "already-completed",
					eventCount: completed.event_count,
				} as const;
			}

			const startedAt = (yield* DateTime.nowAsDate).toISOString();
			yield* sql`
				INSERT INTO backfill_runs
					(backfill_name, status, started_at, completed_at, event_count)
				VALUES (${BACKFILL_NAME}, 'running', ${startedAt}, NULL, 0)
				ON CONFLICT(backfill_name) DO UPDATE SET
					status = 'running', started_at = excluded.started_at,
					completed_at = NULL, event_count = 0
			`;

			const sessions = yield* sql<SessionRow>`
				SELECT id, chat_id, project_id, title, provider_id, model, status,
					cursor, resume_strategy, runtime_mode, agents_json, worktree_id,
					forked_from_session_id, forked_from_message_id, permission_mode,
					tool_search, queue_paused, created_at, updated_at, archived_at
				FROM sessions ORDER BY created_at, id
			`;
			const chats = yield* sql<ChatRow>`
				SELECT id, project_id, worktree_id, title, active_session_id,
					origin_session_id, archived_at, archived_worktree_json,
					last_read_at, created_at, updated_at
				FROM chats ORDER BY created_at, id
			`;
			const messages = yield* sql<MessageRow>`
				SELECT rowid AS row_id, id, session_id, role, kind, content_json,
					parent_item_id, created_at
				FROM messages ORDER BY created_at, rowid
			`;
			// Migration 0020 created message events before lifecycle events existed.
			// Replace only those deterministic legacy rows so a replay from sequence
			// zero observes ChatCreated / SessionCreated before MessagePersisted.
			yield* sql`
			DELETE FROM events
				WHERE type = 'MessagePersisted'
					AND event_id IN (
						SELECT 'backfill:' || id FROM messages
					)
			`;
			// Removing the legacy version-1 message event can leave a session stream
			// starting at version 2. Compact versions inside the transaction so the
			// next live append observes a head equal to the number of evolved events.
			yield* sql`
				UPDATE events SET stream_version = -sequence
				WHERE stream_kind = 'session'
			`;
			yield* sql`
				WITH ranked AS (
					SELECT event_id,
						ROW_NUMBER() OVER (
							PARTITION BY stream_kind, stream_id ORDER BY sequence
						) AS stream_version
					FROM events WHERE stream_kind = 'session'
				)
				UPDATE events
				SET stream_version = (
					SELECT ranked.stream_version FROM ranked
					WHERE ranked.event_id = events.event_id
				)
				WHERE stream_kind = 'session'
			`;
			const existingEvents = yield* sql<ExistingEventRow>`
				SELECT event_id, stream_kind, stream_id, type,
					CASE WHEN type = 'MessagePersisted' AND json_valid(payload_json)
						THEN json_extract(payload_json, '$.messageId')
						ELSE NULL
					END AS message_id
				FROM events
			`;
			const messageSnapshots = messages.map((row) => ({
				rowId: row.row_id,
				messageId: row.id,
				sessionId: row.session_id,
				role: row.role,
				kind: row.kind,
				contentJson: row.content_json,
				parentItemId: row.parent_item_id,
				createdAt: requiredTimestamp(row.created_at, "messages.created_at"),
			}));
			const messagesById = new Map(
				messageSnapshots.map((message) => [message.messageId, message]),
			);
			for (const existing of existingEvents) {
				if (existing.message_id === null) continue;
				const message = messagesById.get(existing.message_id);
				if (message === undefined) continue;
				yield* sql`
					UPDATE events
					SET payload_json = ${JSON.stringify(messageEventFromSnapshot(message))}
					WHERE event_id = ${existing.event_id}
				`;
			}

			const sessionSnapshots = yield* Effect.forEach(sessions, (row) =>
				Effect.gen(function* () {
					const status = yield* decodeSessionStatus(row.status);
					const resumeStrategy = yield* decodeResumeStrategy(
						row.resume_strategy,
					);
					const runtimeMode = yield* decodeRuntimeMode(row.runtime_mode);
					const permissionMode = yield* decodePermissionMode(
						row.permission_mode,
					);
					return {
						sessionId: row.id,
						chatId: row.chat_id,
						projectId: row.project_id,
						title: row.title,
						providerId: row.provider_id,
						model: row.model,
						status,
						cursor: row.cursor,
						resumeStrategy,
						runtimeMode,
						agentsJson: row.agents_json,
						worktreeId: row.worktree_id,
						forkedFromSessionId: row.forked_from_session_id,
						forkedFromMessageId: row.forked_from_message_id,
						permissionMode,
						toolSearch: row.tool_search !== 0,
						queuePaused: row.queue_paused !== 0,
						createdAt: requiredTimestamp(row.created_at, "sessions.created_at"),
						updatedAt: requiredTimestamp(row.updated_at, "sessions.updated_at"),
						archivedAt: timestamp(row.archived_at, "sessions.archived_at"),
						deletedAt: null,
					};
				}),
			);
			for (const session of sessionSnapshots) {
				yield* sql`
					UPDATE events
					SET payload_json = ${JSON.stringify(
						sessionCreatedEventFromSnapshot(session),
					)}
					WHERE event_id = ${`backfill:session-created:${session.sessionId}`}
						AND type = 'SessionCreated'
				`;
			}
			const existingEventIds = new Set(
				existingEvents.map((row) => row.event_id),
			);
			const existingTransitions = new Set(
				existingEvents.map(
					(row) => `${row.stream_kind}:${row.stream_id}:${row.type}`,
				),
			);
			for (const session of sessionSnapshots) {
				const prefix = `session:${session.sessionId}:`;
				if (existingTransitions.has(`${prefix}SessionCreated`)) {
					existingEventIds.add(`backfill:session-created:${session.sessionId}`);
				}
				if (existingTransitions.has(`${prefix}SessionTitleSet`)) {
					existingEventIds.add(`backfill:session-title:${session.sessionId}`);
				}
				if (existingTransitions.has(`${prefix}SessionArchived`)) {
					existingEventIds.add(
						`backfill:session-archived:${session.sessionId}`,
					);
				}
				if (existingTransitions.has(`${prefix}SessionDeleted`)) {
					existingEventIds.add(`backfill:session-deleted:${session.sessionId}`);
				}
			}

			const events = synthesizeBackfill({
				sessions: sessionSnapshots,
				messages: messageSnapshots,
				existingEventIds,
				existingMessageIds: new Set(
					existingEvents.flatMap((row) =>
						row.message_id === null ? [] : [row.message_id],
					),
				),
			});
			const chatEvents: Array<ChatBackfillEvent> = [];
			const postSessionChatEvents: Array<ChatBackfillEvent> = [];
			for (const chat of chats) {
				const createdAt = requiredTimestamp(
					chat.created_at,
					"chats.created_at",
				);
				const createdEventId = `backfill:chat-created:${chat.id}`;
				if (
					!existingEventIds.has(createdEventId) &&
					!existingTransitions.has(`chat:${chat.id}:ChatCreated`)
				) {
					chatEvents.push({
						eventId: createdEventId,
						streamId: chat.id,
						occurredAt: createdAt,
						event: {
							_tag: "ChatCreated",
							chatId: chat.id,
							projectId: chat.project_id,
							worktreeId: chat.worktree_id,
							title: chat.title,
							originSessionId: chat.origin_session_id,
							lastReadAt: timestamp(chat.last_read_at, "chats.last_read_at"),
							createdAt,
						},
					});
				}
				const archivedAt = timestamp(chat.archived_at, "chats.archived_at");
				const archivedEventId = `backfill:chat-archived:${chat.id}`;
				if (
					archivedAt !== null &&
					!existingEventIds.has(archivedEventId) &&
					!existingTransitions.has(`chat:${chat.id}:ChatArchived`)
				) {
					chatEvents.push({
						eventId: archivedEventId,
						streamId: chat.id,
						occurredAt: archivedAt,
						event: {
							_tag: "ChatArchived",
							archivedAt,
							archivedWorktreeJson: chat.archived_worktree_json,
						},
					});
				}
				const activeEventId = `backfill:chat-active:${chat.id}`;
				if (
					!existingEventIds.has(activeEventId) &&
					!existingTransitions.has(`chat:${chat.id}:ChatActiveSessionSet`)
				) {
					const updatedAt = requiredTimestamp(
						chat.updated_at,
						"chats.updated_at",
					);
					postSessionChatEvents.push({
						eventId: activeEventId,
						streamId: chat.id,
						occurredAt: updatedAt,
						event: {
							_tag: "ChatActiveSessionSet",
							sessionId: chat.active_session_id,
							updatedAt,
						},
					});
				}
			}

			const chatVersionRows = yield* sql<StreamVersionRow>`
				SELECT stream_id, MAX(stream_version) AS stream_version
				FROM events WHERE stream_kind = 'chat'
				GROUP BY stream_id
			`;
			const chatVersions = new Map(
				chatVersionRows.map((row) => [row.stream_id, row.stream_version]),
			);
			for (const item of chatEvents) {
				const streamVersion = (chatVersions.get(item.streamId) ?? 0) + 1;
				chatVersions.set(item.streamId, streamVersion);
				yield* sql`
					INSERT INTO events
						(event_id, correlation_id, causation_event_id, stream_kind,
						 stream_id, stream_version, type, occurred_at, actor, payload_json)
					VALUES
						(${item.eventId}, ${item.eventId}, NULL, 'chat', ${item.streamId},
						 ${streamVersion}, ${item.event._tag},
						 ${new Date(item.occurredAt).toISOString()}, 'backfill',
						 ${JSON.stringify(item.event)})
				`;
			}

			const versionRows = yield* sql<StreamVersionRow>`
				SELECT stream_id, MAX(stream_version) AS stream_version
				FROM events WHERE stream_kind = 'session'
				GROUP BY stream_id
			`;
			const versions = new Map(
				versionRows.map((row) => [row.stream_id, row.stream_version]),
			);
			for (const item of events) {
				const streamVersion = (versions.get(item.streamId) ?? 0) + 1;
				versions.set(item.streamId, streamVersion);
				yield* sql`
					INSERT INTO events
						(event_id, correlation_id, causation_event_id, stream_kind,
						 stream_id, stream_version, type, occurred_at, actor, payload_json)
					VALUES
						(${item.eventId}, ${item.correlationId}, NULL, 'session',
						 ${item.streamId}, ${streamVersion}, ${item.event._tag},
						 ${new Date(item.occurredAt).toISOString()}, ${item.actor},
						 ${JSON.stringify(item.event)})
				`;
			}
			for (const item of postSessionChatEvents) {
				const streamVersion = (chatVersions.get(item.streamId) ?? 0) + 1;
				chatVersions.set(item.streamId, streamVersion);
				yield* sql`
          INSERT INTO events
            (event_id, correlation_id, causation_event_id, stream_kind,
             stream_id, stream_version, type, occurred_at, actor, payload_json)
          VALUES
            (${item.eventId}, ${item.eventId}, NULL, 'chat', ${item.streamId},
             ${streamVersion}, ${item.event._tag},
             ${new Date(item.occurredAt).toISOString()}, 'backfill',
             ${JSON.stringify(item.event)})
        `;
			}
			yield* sql`
				UPDATE messages
				SET sequence = COALESCE(
					(SELECT sequence FROM events
					 WHERE event_id = 'backfill:message:' || messages.id),
					sequence
				)
			`;

			const heads = yield* sql<{ readonly sequence: number }>`
				SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events
			`;
			const head = heads[0]?.sequence ?? 0;
			const completedAt = (yield* DateTime.nowAsDate).toISOString();
			for (const projector of PROJECTORS) {
				yield* sql`
					INSERT INTO projector_cursors
						(projector_name, last_sequence, updated_at)
					VALUES (${projector}, ${head}, ${completedAt})
					ON CONFLICT(projector_name) DO UPDATE SET
						last_sequence = excluded.last_sequence,
						updated_at = excluded.updated_at
				`;
			}
			yield* sql`
				UPDATE backfill_runs SET
					status = 'completed', completed_at = ${completedAt},
					event_count = ${events.length + chatEvents.length + postSessionChatEvents.length}
				WHERE backfill_name = ${BACKFILL_NAME}
			`;
			return {
				status: "completed",
				eventCount:
					events.length + chatEvents.length + postSessionChatEvents.length,
			} as const;
		}),
	);
});
