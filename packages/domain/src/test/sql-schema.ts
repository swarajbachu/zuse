import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const createDomainTestSchema = Effect.fn("createDomainTestSchema")(
	function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`
		CREATE TABLE chats (
			id TEXT PRIMARY KEY,
			project_id TEXT,
			worktree_id TEXT,
			title TEXT,
			active_session_id TEXT,
			origin_session_id TEXT,
			archived_at TEXT,
			archived_worktree_json TEXT,
			last_message_at TEXT,
			last_read_at TEXT,
			created_at TEXT,
			updated_at TEXT
		)
	`;
		yield* sql`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL,
			title TEXT NOT NULL,
			provider_id TEXT NOT NULL,
			model TEXT NOT NULL,
			status TEXT NOT NULL,
			archived_at TEXT,
			cursor TEXT,
			resume_strategy TEXT NOT NULL,
			runtime_mode TEXT NOT NULL,
			agents_json TEXT,
			worktree_id TEXT,
			chat_id TEXT NOT NULL,
			forked_from_session_id TEXT,
			forked_from_message_id TEXT,
			permission_mode TEXT NOT NULL,
			tool_search INTEGER NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`;
		yield* sql`
		CREATE TABLE messages (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			role TEXT NOT NULL,
			kind TEXT NOT NULL,
			content_json TEXT NOT NULL,
			parent_item_id TEXT,
			created_at TEXT NOT NULL,
			sequence INTEGER NOT NULL
		)
	`;
		yield* sql`
		CREATE TABLE events (
			sequence INTEGER PRIMARY KEY AUTOINCREMENT,
			event_id TEXT NOT NULL UNIQUE,
			stream_kind TEXT NOT NULL,
			stream_id TEXT NOT NULL,
			stream_version INTEGER NOT NULL,
			type TEXT NOT NULL,
			occurred_at TEXT NOT NULL,
			actor TEXT,
			payload_json TEXT NOT NULL,
			correlation_id TEXT,
			causation_event_id TEXT,
			UNIQUE (stream_kind, stream_id, stream_version)
		)
	`;
		yield* sql`
		CREATE TABLE projector_cursors (
			projector_name TEXT PRIMARY KEY,
			last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
			updated_at TEXT NOT NULL
		)
	`;
		yield* sql`
		CREATE TABLE command_receipts (
			command_id TEXT PRIMARY KEY,
			stream_kind TEXT NOT NULL,
			stream_id TEXT NOT NULL,
			stream_version INTEGER NOT NULL,
			event_ids_json TEXT NOT NULL,
			result_json TEXT,
			created_at TEXT NOT NULL
		)
	`;
		yield* sql`
		CREATE TABLE projected_messages (
			message_id TEXT PRIMARY KEY,
			content_json TEXT NOT NULL
		)
	`;
	},
);
