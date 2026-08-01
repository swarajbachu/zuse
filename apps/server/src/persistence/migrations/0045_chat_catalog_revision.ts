import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Maintain one cheap durable cursor for the chat sidebar read model.
 *
 * Both local projectors and other server runtimes write the `chats` table, so
 * an in-memory signal or connection-local SQLite counter cannot cover every
 * mutation without also waking on unrelated persistence.
 */
export const Migration0045ChatCatalogRevision = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`
		CREATE TABLE chat_catalog_revision (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			revision INTEGER NOT NULL
		)
	`;
	yield* sql`
		INSERT INTO chat_catalog_revision (id, revision)
		VALUES (1, 0)
	`;
	yield* sql`
		CREATE TRIGGER chat_catalog_revision_insert
		AFTER INSERT ON chats
		BEGIN
			UPDATE chat_catalog_revision SET revision = revision + 1 WHERE id = 1;
		END
	`;
	yield* sql`
		CREATE TRIGGER chat_catalog_revision_delete
		AFTER DELETE ON chats
		BEGIN
			UPDATE chat_catalog_revision SET revision = revision + 1 WHERE id = 1;
		END
	`;
	yield* sql`
		CREATE TRIGGER chat_catalog_revision_update
		AFTER UPDATE OF
			project_id,
			worktree_id,
			title,
			title_provenance,
			active_session_id,
			origin_session_id,
			archived_at,
			last_message_at,
			last_read_at,
			created_at,
			updated_at
		ON chats
		WHEN
			OLD.project_id IS NOT NEW.project_id OR
			OLD.worktree_id IS NOT NEW.worktree_id OR
			OLD.title IS NOT NEW.title OR
			OLD.title_provenance IS NOT NEW.title_provenance OR
			OLD.active_session_id IS NOT NEW.active_session_id OR
			OLD.origin_session_id IS NOT NEW.origin_session_id OR
			OLD.archived_at IS NOT NEW.archived_at OR
			OLD.last_message_at IS NOT NEW.last_message_at OR
			OLD.last_read_at IS NOT NEW.last_read_at OR
			OLD.created_at IS NOT NEW.created_at OR
			OLD.updated_at IS NOT NEW.updated_at
		BEGIN
			UPDATE chat_catalog_revision SET revision = revision + 1 WHERE id = 1;
		END
	`;
});
