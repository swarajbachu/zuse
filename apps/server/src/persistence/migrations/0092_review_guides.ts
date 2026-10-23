import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * One guided review per workspace. A run writes in memory and swaps its
 * finished guide in here whole, so a reader never sees half a guide and a
 * restart mid-run leaves the previous guide intact.
 */
export const Migration0092ReviewGuides = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE IF NOT EXISTS review_guides (
		id TEXT PRIMARY KEY,
		folder_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
		worktree_id TEXT REFERENCES worktrees(id) ON DELETE CASCADE,
		workspace_key TEXT NOT NULL UNIQUE,
		status TEXT NOT NULL,
		origin_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
		provider_id TEXT NOT NULL, model TEXT NOT NULL,
		base_sha TEXT NOT NULL, head_sha TEXT NOT NULL,
		overview_json TEXT, error TEXT,
		created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
	)`;
	yield* sql`CREATE TABLE IF NOT EXISTS review_guide_chapters (
		guide_id TEXT NOT NULL REFERENCES review_guides(id) ON DELETE CASCADE,
		id TEXT NOT NULL, ordinal INTEGER NOT NULL, kind TEXT NOT NULL,
		title TEXT NOT NULL, summary TEXT NOT NULL,
		hunk_ids_json TEXT NOT NULL, validated_by_json TEXT NOT NULL,
		ask_hints_json TEXT NOT NULL, auto INTEGER NOT NULL,
		PRIMARY KEY(guide_id, id)
	)`;
});
