import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
// Migration 55 was also used by staging_api_origin in development profiles.
// Preserve tables and grants if an earlier bridge build already created them.
export const Migration0056DeviceBridge = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE IF NOT EXISTS device_bridge_config (id INTEGER PRIMARY KEY CHECK(id = 1), link_key TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0)`;
	yield* sql`CREATE TABLE IF NOT EXISTS device_command_grants (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`;
	yield* sql`CREATE TABLE IF NOT EXISTS device_commands (id TEXT PRIMARY KEY, state TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL)`;
	yield* sql`CREATE INDEX IF NOT EXISTS device_commands_state ON device_commands(state)`;
	yield* sql`CREATE INDEX IF NOT EXISTS device_commands_created ON device_commands(created_at DESC)`;
});
