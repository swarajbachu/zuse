import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { CompleteSessionCreatedEvent } from "../core/session-fields.js";
import type { StoredEvent } from "../engine/dispatch.js";
import type { ProjectorDefinition } from "../engine/projector-runner.js";

export class SessionProjectionDecodeError extends Schema.TaggedErrorClass<SessionProjectionDecodeError>()(
	"SessionProjectionDecodeError",
	{
		eventId: Schema.String,
		reason: Schema.String,
	},
) {}

export type SqlSessionProjectorError = SqlError | SessionProjectionDecodeError;

const decodeCreated = Schema.decodeUnknownEffect(CompleteSessionCreatedEvent);

export const makeSqlSessionProjector = (
	sql: SqlClient.SqlClient,
): ProjectorDefinition<StoredEvent, SqlSessionProjectorError> => ({
	name: "session-read-model",
	sequenceOf: (record) => record.sequence,
	apply: Effect.fn("SqlSessionProjector.apply")(function* (
		record: StoredEvent,
	) {
		const event = record.event;
		switch (event._tag) {
			case "SessionCreated": {
				const created = yield* decodeCreated(event).pipe(
					Effect.mapError(
						(cause) =>
							new SessionProjectionDecodeError({
								eventId: record.eventId,
								reason: String(cause),
							}),
					),
				);
				const createdAt = new Date(created.createdAt).toISOString();
				yield* sql`
					INSERT OR IGNORE INTO sessions
						(id, project_id, title, provider_id, model, status,
						 archived_at, cursor, resume_strategy, runtime_mode,
						 agents_json, worktree_id, chat_id, forked_from_session_id,
						 forked_from_message_id, permission_mode, tool_search,
						 created_at, updated_at)
					VALUES
						(${created.sessionId}, ${created.projectId}, ${created.title},
						 ${created.providerId}, ${created.model}, ${created.status}, NULL,
						 ${created.cursor}, ${created.resumeStrategy}, ${created.runtimeMode},
						 ${created.agentsJson}, ${created.worktreeId}, ${created.chatId},
						 ${created.forkedFromSessionId}, ${created.forkedFromMessageId},
						 ${created.permissionMode}, ${created.toolSearch ? 1 : 0},
						 ${createdAt}, ${createdAt})
				`;
				yield* sql`
					UPDATE chats
					SET active_session_id = ${created.sessionId}, updated_at = ${createdAt}
					WHERE id = ${created.chatId}
				`;
				return;
			}
			case "SessionTitleSet": {
				const updatedAt = new Date(event.updatedAt).toISOString();
				yield* sql`
					UPDATE sessions SET title = ${event.title}, updated_at = ${updatedAt}
					WHERE id = ${record.streamId}
				`;
				return;
			}
			case "SessionModelSet": {
				const updatedAt = new Date(event.updatedAt).toISOString();
				yield* sql`
					UPDATE sessions SET model = ${event.model}, updated_at = ${updatedAt}
					WHERE id = ${record.streamId}
				`;
				return;
			}
			case "SessionProviderSet": {
				const updatedAt = new Date(event.updatedAt).toISOString();
				yield* sql`
					UPDATE sessions
					SET provider_id = ${event.providerId}, model = ${event.model},
						cursor = NULL, resume_strategy = 'none', updated_at = ${updatedAt}
					WHERE id = ${record.streamId}
				`;
				return;
			}
			case "SessionRuntimeModeSet": {
				const updatedAt = new Date(event.updatedAt).toISOString();
				yield* sql`
					UPDATE sessions
					SET runtime_mode = ${event.runtimeMode}, updated_at = ${updatedAt}
					WHERE id = ${record.streamId}
				`;
				return;
			}
			case "SessionPermissionModeSet": {
				const updatedAt = new Date(event.updatedAt).toISOString();
				yield* sql`
					UPDATE sessions
					SET permission_mode = ${event.permissionMode}, updated_at = ${updatedAt}
					WHERE id = ${record.streamId}
				`;
				return;
			}
			case "SessionWorktreeSet": {
				const updatedAt = new Date(event.updatedAt).toISOString();
				yield* sql`
					UPDATE sessions
					SET worktree_id = ${event.worktreeId}, cursor = NULL,
						resume_strategy = 'none', updated_at = ${updatedAt}
					WHERE id = ${record.streamId}
				`;
				return;
			}
			case "SessionStatusSet": {
				const updatedAt = new Date(event.updatedAt).toISOString();
				yield* sql`
					UPDATE sessions SET status = ${event.status}, updated_at = ${updatedAt}
					WHERE id = ${record.streamId}
				`;
				return;
			}
			case "SessionResumeSet": {
				const updatedAt = new Date(event.updatedAt).toISOString();
				yield* sql`
					UPDATE sessions
					SET cursor = ${event.cursor}, resume_strategy = ${event.resumeStrategy},
						updated_at = ${updatedAt}
					WHERE id = ${record.streamId}
				`;
				return;
			}
			case "SessionArchived": {
				const archivedAt = new Date(event.archivedAt).toISOString();
				yield* sql`
					UPDATE sessions
					SET archived_at = ${archivedAt}, updated_at = ${archivedAt}
					WHERE id = ${record.streamId}
				`;
				return;
			}
			case "SessionUnarchived": {
				const unarchivedAt = new Date(event.unarchivedAt).toISOString();
				yield* sql`
					UPDATE sessions SET archived_at = NULL, updated_at = ${unarchivedAt}
					WHERE id = ${record.streamId}
				`;
				return;
			}
			case "SessionDeleted":
				yield* sql`DELETE FROM sessions WHERE id = ${record.streamId}`;
				return;
			case "TurnStarted": {
				const startedAt = new Date(event.startedAt).toISOString();
				yield* sql`
					UPDATE sessions SET status = 'running', updated_at = ${startedAt}
					WHERE id = ${record.streamId}
				`;
				return;
			}
			case "TurnSettled": {
				const settledAt = new Date(event.settledAt).toISOString();
				yield* sql`
					UPDATE sessions SET status = 'idle', updated_at = ${settledAt}
					WHERE id = ${record.streamId}
				`;
				return;
			}
			case "MessagePersisted": {
				const createdAt = new Date(event.createdAt).toISOString();
				yield* sql`
					INSERT OR IGNORE INTO messages
						(id, session_id, role, kind, content_json, parent_item_id,
						 created_at, sequence)
					VALUES
						(${event.messageId}, ${record.streamId}, ${event.role},
						 ${event.kind}, ${event.contentJson}, ${event.parentItemId},
						 ${createdAt}, ${record.sequence})
				`;
				yield* sql`
					UPDATE sessions SET updated_at = ${createdAt}
					WHERE id = ${record.streamId}
				`;
				yield* sql`
					UPDATE chats SET last_message_at = ${createdAt}
					WHERE id = (
						SELECT chat_id FROM sessions WHERE id = ${record.streamId}
					)
				`;
				return;
			}
			case "ProviderAttached":
			case "ProviderStopRequested":
			case "ProviderDetached":
			case "SegmentOpened":
			case "SegmentSettled":
			case "PermissionRequested":
			case "PermissionResolved":
				return;
		}
	}),
});
