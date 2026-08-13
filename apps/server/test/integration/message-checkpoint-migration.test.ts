import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";

import { Migration0047MessageCheckpoints } from "../../src/persistence/migrations/0047_message_checkpoints.ts";

describe("message checkpoint migration", () => {
	it("rebuilds durable high-water and final metadata from the event log", async () => {
		const runtime = ManagedRuntime.make(sqliteLayer({ filename: ":memory:" }));
		try {
			const rows = await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
						CREATE TABLE messages (
							id TEXT PRIMARY KEY,
							session_id TEXT NOT NULL,
							content_json TEXT NOT NULL
						)
					`;
					yield* sql`
						CREATE TABLE events (
							stream_kind TEXT NOT NULL,
							stream_id TEXT NOT NULL,
							stream_version INTEGER NOT NULL,
							type TEXT NOT NULL,
							payload_json TEXT NOT NULL
						)
					`;
					yield* sql`
						INSERT INTO messages (id, session_id, content_json)
						VALUES ('message-1', 'session-1', '{}'), ('legacy', 'session-1', '{}')
					`;
					yield* sql`
						INSERT INTO events
							(stream_kind, stream_id, stream_version, type, payload_json)
						VALUES
							('session', 'session-1', 2, 'MessagePersisted',
							 '{"messageId":"message-1","checkpointRevision":1,"checkpointFinal":false}'),
							('session', 'session-1', 3, 'MessagePersisted',
							 '{"messageId":"message-1","checkpointRevision":2,"checkpointFinal":true}')
					`;
					yield* Migration0047MessageCheckpoints;
					return yield* sql<{
						readonly id: string;
						readonly checkpoint_revision: number | null;
						readonly checkpoint_final: number | null;
					}>`
						SELECT id, checkpoint_revision, checkpoint_final
						FROM messages ORDER BY id
					`;
				}),
			);

			expect(rows).toEqual([
				{ id: "legacy", checkpoint_revision: null, checkpoint_final: null },
				{ id: "message-1", checkpoint_revision: 2, checkpoint_final: 1 },
			]);
		} finally {
			await runtime.dispose();
		}
	});
});
