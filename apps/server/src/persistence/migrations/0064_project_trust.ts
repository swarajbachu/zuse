import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Per-project trust gate for repository-provided configuration
 * (`.zuse/settings.*` scripts/env/overrides and `.mcp.json` servers).
 *
 * `trusted = 0` means the repository's config is held back until the user
 * grants trust once; the flag lives on the project row — never inside
 * `.zuse/settings.*`, which the repository itself controls and could use
 * to self-trust. Existing projects stay untrusted too: repo config still
 * executes on every session start / worktree setup, so gating them keeps
 * protecting checkouts that were added before this column existed.
 */
export const Migration0064ProjectTrust = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`ALTER TABLE projects ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0`;
});
