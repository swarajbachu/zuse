import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Adds v3 mailbox identity without changing legacy receipt writers. */
export const Migration0053CloudCommandReceipts = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`ALTER TABLE command_receipts ADD COLUMN fingerprint TEXT`;
	yield* sql`ALTER TABLE command_receipts ADD COLUMN command_kind TEXT`;
	yield* sql`ALTER TABLE command_receipts ADD COLUMN schema_version INTEGER`;
	yield* sql`ALTER TABLE command_receipts ADD COLUMN storage_incarnation_id TEXT`;
});
