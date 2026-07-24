import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Protect existing names while new provisional names opt in explicitly. */
export const Migration0043NameProvenance = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`
		ALTER TABLE chats
		ADD COLUMN title_provenance TEXT NOT NULL DEFAULT 'manual'
	`;
	yield* sql`
		ALTER TABLE sessions
		ADD COLUMN title_provenance TEXT NOT NULL DEFAULT 'manual'
	`;
	yield* sql`
		ALTER TABLE worktrees
		ADD COLUMN branch_provenance TEXT NOT NULL DEFAULT 'manual'
	`;
	yield* sql`
		ALTER TABLE messages
		ADD COLUMN turn_id TEXT
	`;
	yield* sql`
		CREATE INDEX IF NOT EXISTS idx_messages_session_turn
		ON messages(session_id, turn_id, created_at)
	`;
});
