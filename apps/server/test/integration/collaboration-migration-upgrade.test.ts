import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { Migration0055StagingApiOrigin } from "../../src/persistence/migrations/0055_staging_api_origin.ts";
import { Migration0056DeviceBridge } from "../../src/persistence/migrations/0056_device_bridge.ts";
import { Migration0057DeviceBridgeDefaultAccess } from "../../src/persistence/migrations/0057_device_bridge_default_access.ts";
import { Migration0058QuestionAnswerDeliveries } from "../../src/persistence/migrations/0058_question_answer_deliveries.ts";
import { Migration0059EventSequenceIndex } from "../../src/persistence/migrations/0059_event_sequence_index.ts";
import { Migration0060ChatUserMessageTime } from "../../src/persistence/migrations/0060_chat_user_message_time.ts";
import {
	MigrationsLive,
	MigrationsThrough0054Live,
} from "../../src/persistence/migrations.ts";

it.each([
	{ legacyId: 58, recency: false, masters: false },
	{ legacyId: 59, recency: false, masters: false },
	{ legacyId: 59, recency: true, masters: false },
	{ legacyId: 59, recency: true, masters: true },
	{ legacyId: 61, recency: true, masters: false },
])("preserves branch migration $legacyId with recency=$recency masters=$masters across restart", async ({
	legacyId,
	recency,
	masters,
}) => {
	const sqlite = sqliteLayer({ filename: ":memory:" });
	const runtime = ManagedRuntime.make(
		Layer.merge(sqlite, MigrationsThrough0054Live.pipe(Layer.provide(sqlite))),
	);
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* Migration0055StagingApiOrigin;
				yield* Migration0056DeviceBridge;
				yield* Migration0057DeviceBridgeDefaultAccess;
				yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'staging_api_origin'), (56, 'device_bridge'), (57, 'device_bridge_default_access')`;
				if (legacyId >= 59) {
					if (masters) {
						yield* sql`CREATE TABLE masters (id TEXT PRIMARY KEY)`;
						yield* sql`INSERT INTO masters VALUES ('preserved')`;
						yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (58, 'masters')`;
					} else {
						yield* Migration0058QuestionAnswerDeliveries;
						yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (58, 'question_answer_deliveries')`;
					}
				}
				if (legacyId === 61) {
					yield* Migration0059EventSequenceIndex;
					yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (59, 'event_sequence_index')`;
				}
				// Existing installations keep their historical tables; new installs
				// only reserve the migration slot while shared-host work is deferred.
				yield* sql`CREATE TABLE collaboration_teams (id TEXT PRIMARY KEY, name TEXT, created_at TEXT, updated_at TEXT)`;
				yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${legacyId}, 'collaboration_foundation')`;
				yield* sql`INSERT INTO collaboration_teams (id, name, created_at, updated_at) VALUES ('team', 'Preserved', '2026-09-01', '2026-09-01')`;
				if (recency) {
					yield* Migration0060ChatUserMessageTime;
					yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (60, 'chat_user_message_time')`;
				}
			}),
		);
		for (let restart = 0; restart < 2; restart++) {
			await runtime.runPromise(
				Effect.void.pipe(Effect.provide(MigrationsLive)),
			);
		}
		const state = await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return {
					masters: masters ? yield* sql`SELECT id FROM masters` : [],
					questionDeliveries:
						yield* sql`SELECT name FROM sqlite_master WHERE name = 'question_answer_deliveries'`,
					teams: yield* sql`SELECT id, name FROM collaboration_teams`,
					harness: yield* sql`SELECT root_id FROM harness_executions`,
					connections:
						yield* sql`SELECT connection_id FROM model_connection_secrets`,
					ledger:
						yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 58 ORDER BY migration_id`,
					indexes:
						yield* sql`SELECT name FROM sqlite_master WHERE name = 'idx_events_kind_sequence'`,
					columns: yield* sql<{ name: string }>`PRAGMA table_info(chats)`,
				};
			}),
		);
		expect(state.teams).toEqual([{ id: "team", name: "Preserved" }]);
		expect(state.masters).toEqual(masters ? [{ id: "preserved" }] : []);
		expect(state.questionDeliveries).toHaveLength(1);
		expect(state.ledger).toEqual([
			{ migration_id: 58, name: "question_answer_deliveries" },
			{ migration_id: 59, name: "event_sequence_index" },
			{ migration_id: 60, name: "chat_user_message_time" },
			{ migration_id: 61, name: "harness_executions" },
			{ migration_id: 62, name: "model_connections" },
			{ migration_id: 63, name: "project_workspace_key" },
			{ migration_id: 64, name: "provider_accounts" },
		]);
		expect(state.harness).toEqual([]);
		expect(state.connections).toEqual([]);
		expect(state.indexes).toHaveLength(1);
		expect(
			state.columns.some((column) => column.name === "last_user_message_at"),
		).toBe(true);
	} finally {
		await runtime.dispose();
	}
});
