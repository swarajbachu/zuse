import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";

import type { ChatEvent } from "../chat/events.js";
import type { StoredEvent } from "../engine/dispatch.js";
import type { ProjectorDefinition } from "../engine/projector-runner.js";

export const makeSqlChatProjector = (
	sql: SqlClient.SqlClient,
): ProjectorDefinition<StoredEvent<ChatEvent>, SqlError> => ({
	name: "chat-read-model",
	sequenceOf: (record) => record.sequence,
	apply: Effect.fn("SqlChatProjector.apply")(function* (
		record: StoredEvent<ChatEvent>,
	) {
		const event = record.event;
		switch (event._tag) {
			case "ChatCreated": {
				const createdAt = new Date(event.createdAt).toISOString();
				const lastReadAt =
					event.lastReadAt === null
						? null
						: new Date(event.lastReadAt).toISOString();
				yield* sql`
					INSERT OR IGNORE INTO chats
						(id, project_id, worktree_id, title, active_session_id,
						 origin_session_id, archived_at, archived_worktree_json,
						 last_message_at, last_read_at, created_at, updated_at)
					VALUES
						(${event.chatId}, ${event.projectId}, ${event.worktreeId},
						 ${event.title}, NULL, ${event.originSessionId}, NULL, NULL,
						 NULL, ${lastReadAt}, ${createdAt}, ${createdAt})
				`;
				return;
			}
			case "ChatRenamed": {
				const updatedAt = new Date(event.updatedAt).toISOString();
				yield* sql`
					UPDATE chats SET title = ${event.title}, updated_at = ${updatedAt}
					WHERE id = ${record.streamId}
				`;
				return;
			}
			case "ChatRead": {
				const readAt = new Date(event.readAt).toISOString();
				yield* sql`
					UPDATE chats SET last_read_at = ${readAt}
					WHERE id = ${record.streamId}
				`;
				return;
			}
			case "ChatWorktreeSet": {
				const updatedAt = new Date(event.updatedAt).toISOString();
				yield* sql`
					UPDATE chats
					SET worktree_id = ${event.worktreeId}, updated_at = ${updatedAt}
					WHERE id = ${record.streamId}
				`;
				return;
			}
			case "ChatActiveSessionSet": {
				const updatedAt = new Date(event.updatedAt).toISOString();
				yield* sql`
					UPDATE chats
					SET active_session_id = ${event.sessionId}, updated_at = ${updatedAt}
					WHERE id = ${record.streamId}
					  AND EXISTS (
						SELECT 1 FROM sessions
						WHERE id = ${event.sessionId} AND chat_id = ${record.streamId}
					  )
				`;
				return;
			}
			case "ChatArchiveRequested":
				return;
			case "ChatArchived": {
				const archivedAt = new Date(event.archivedAt).toISOString();
				yield* sql`
					UPDATE chats
					SET archived_at = ${archivedAt},
						archived_worktree_json = ${event.archivedWorktreeJson},
						updated_at = ${archivedAt}
					WHERE id = ${record.streamId}
				`;
				return;
			}
			case "ChatUnarchived": {
				const unarchivedAt = new Date(event.unarchivedAt).toISOString();
				yield* sql`
					UPDATE chats
					SET archived_at = NULL, worktree_id = ${event.worktreeId},
						archived_worktree_json = NULL, updated_at = ${unarchivedAt}
					WHERE id = ${record.streamId}
				`;
				return;
			}
			case "ChatDeleteRequested":
				return;
			case "ChatDeleted":
				yield* sql`DELETE FROM chats WHERE id = ${record.streamId}`;
				return;
		}
	}),
});
