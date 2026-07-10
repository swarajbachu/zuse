import { synthesizeBackfill } from "@zuse/domain/engine/backfill";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

const BACKFILL_NAME = "session-lifecycle-v2";
const PROJECTORS = ["messages", "sessions", "chats", "activity"] as const;

interface SessionRow {
	readonly id: string;
	readonly chat_id: string;
	readonly project_id: string;
	readonly title: string;
	readonly created_at: string;
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

			const startedAt = new Date().toISOString();
			yield* sql`
				INSERT INTO backfill_runs
					(backfill_name, status, started_at, completed_at, event_count)
				VALUES (${BACKFILL_NAME}, 'running', ${startedAt}, NULL, 0)
				ON CONFLICT(backfill_name) DO UPDATE SET
					status = 'running', started_at = excluded.started_at,
					completed_at = NULL, event_count = 0
			`;

			const sessions = yield* sql<SessionRow>`
				SELECT id, chat_id, project_id, title, created_at, archived_at
				FROM sessions ORDER BY created_at, id
			`;
			const messages = yield* sql<MessageRow>`
				SELECT rowid AS row_id, id, session_id, role, kind, content_json,
					parent_item_id, created_at
				FROM messages ORDER BY created_at, rowid
			`;
			const existingEvents = yield* sql<ExistingEventRow>`
				SELECT event_id,
					CASE WHEN type = 'MessagePersisted'
						THEN json_extract(payload_json, '$.messageId')
						ELSE NULL
					END AS message_id
				FROM events
			`;

			const events = synthesizeBackfill({
				sessions: sessions.map((row) => ({
					sessionId: row.id,
					chatId: row.chat_id,
					projectId: row.project_id,
					title: row.title,
					createdAt: requiredTimestamp(row.created_at, "sessions.created_at"),
					archivedAt: timestamp(row.archived_at, "sessions.archived_at"),
					deletedAt: null,
				})),
				messages: messages.map((row) => ({
					rowId: row.row_id,
					messageId: row.id,
					sessionId: row.session_id,
					role: row.role,
					kind: row.kind,
					contentJson: row.content_json,
					parentItemId: row.parent_item_id,
					createdAt: requiredTimestamp(row.created_at, "messages.created_at"),
				})),
				existingEventIds: new Set(existingEvents.map((row) => row.event_id)),
				existingMessageIds: new Set(
					existingEvents.flatMap((row) =>
						row.message_id === null ? [] : [row.message_id],
					),
				),
			});

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

			const heads = yield* sql<{ readonly sequence: number }>`
				SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events
			`;
			const head = heads[0]?.sequence ?? 0;
			const completedAt = new Date().toISOString();
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
					event_count = ${events.length}
				WHERE backfill_name = ${BACKFILL_NAME}
			`;
			return { status: "completed", eventCount: events.length } as const;
		}),
	);
});
