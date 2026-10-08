import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Records which workspace (Personal or an organization) owns each local project. */
export const Migration0063ProjectWorkspaceKey = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`ALTER TABLE projects ADD COLUMN workspace_key TEXT NOT NULL DEFAULT 'personal'`;
});
