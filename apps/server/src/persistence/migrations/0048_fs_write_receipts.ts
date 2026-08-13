import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * The prepared row is committed before the filesystem mutation. If the
 * process exits after replacing the file but before finalizing the row, the
 * service recognizes the requested content hash and completes the receipt on
 * retry. Identity columns fence accidental command-id reuse.
 */
export const Migration0048FsWriteReceipts = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`
		CREATE TABLE fs_write_receipts (
			command_id TEXT PRIMARY KEY,
			folder_id TEXT NOT NULL,
			worktree_id TEXT,
			path TEXT NOT NULL,
			expected_mtime TEXT NOT NULL,
			content_hash TEXT NOT NULL,
			state TEXT NOT NULL CHECK (state IN ('prepared', 'applied')),
			mtime TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			CHECK (
				(state = 'prepared' AND mtime IS NULL)
				OR (state = 'applied' AND mtime IS NOT NULL)
			)
		)
	`;
	yield* sql`
		CREATE INDEX idx_fs_write_receipts_updated_at
		ON fs_write_receipts(updated_at)
	`;
});
