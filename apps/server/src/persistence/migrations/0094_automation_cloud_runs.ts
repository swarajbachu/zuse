import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Records the sandbox provider and cloud workspace of runs started as cloud agents. */
export const Migration0094AutomationCloudRuns = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`ALTER TABLE automation_runs ADD COLUMN cloud_provider_id TEXT`;
	yield* sql`ALTER TABLE automation_runs ADD COLUMN cloud_workspace_id TEXT`;
});
