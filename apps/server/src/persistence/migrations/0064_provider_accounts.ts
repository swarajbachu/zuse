import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Only metadata lives here. Native CLIs keep credentials in isolated homes. */
export const Migration0064ProviderAccounts = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE provider_accounts (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, name TEXT NOT NULL,
  preferred INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
 )`;
	yield* sql`CREATE UNIQUE INDEX provider_accounts_preferred ON provider_accounts(provider_id) WHERE preferred=1`;
	yield* sql`CREATE TABLE session_provider_accounts (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL, account_id TEXT,
  PRIMARY KEY(session_id,provider_id)
 )`;
	// Existing sessions belong to the native/default login, including dormant ones.
	yield* sql`INSERT INTO session_provider_accounts(session_id,provider_id,account_id)
 SELECT id,provider_id,NULL FROM sessions WHERE provider_id IN ('claude','codex')`;
});
