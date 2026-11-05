import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
export const Migration0093ProjectAutomations = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE automations (id TEXT PRIMARY KEY, create_request_id TEXT UNIQUE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, config_json TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, next_run_at TEXT)`;
	yield* sql`CREATE TABLE automation_session_policies (session_id TEXT PRIMARY KEY, config_json TEXT NOT NULL, created_at TEXT NOT NULL)`;
	yield* sql`CREATE TRIGGER automation_policy_session_cleanup AFTER DELETE ON sessions BEGIN DELETE FROM automation_session_policies WHERE session_id=OLD.id; END`;
	yield* sql`CREATE TABLE automation_runs (id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE, event_id TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, session_id TEXT, chat_id TEXT, config_json TEXT NOT NULL, prompt TEXT NOT NULL, context_json TEXT NOT NULL DEFAULT '{}', completion_reported INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error TEXT, UNIQUE(automation_id,event_id))`;
	yield* sql`CREATE INDEX automation_runs_status ON automation_runs(status,created_at)`;
	yield* sql`CREATE INDEX automation_runs_session ON automation_runs(session_id,created_at)`;
	yield* sql`CREATE INDEX automation_runs_owner ON automation_runs(automation_id,created_at)`;
	yield* sql`CREATE TABLE automation_notifications (run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE, destination TEXT NOT NULL, channel TEXT NOT NULL, delivered_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, last_error TEXT, PRIMARY KEY(run_id,channel,destination))`;
});
