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
import { Migration0063ProjectWorkspaceKey } from "../../src/persistence/migrations/0063_project_workspace_key.ts";
import { Migration0064ProviderAccounts } from "../../src/persistence/migrations/0064_provider_accounts.ts";
import { Migration0065Masters } from "../../src/persistence/migrations/0065_masters.ts";
import { Migration0087ScratchFolders } from "../../src/persistence/migrations/0087_scratch_folders.ts";
import { Migration0088ScratchFoldersRepair } from "../../src/persistence/migrations/0088_scratch_folders_repair.ts";
import { Migration0089DeviceBridgeEnrollment } from "../../src/persistence/migrations/0089_device_bridge_enrollment.ts";
import {
	MigrationsLive,
	MigrationsThrough0054Live,
	MigrationsThrough0062Live,
	MigrationsThrough0086Live,
} from "../../src/persistence/migrations.ts";

it.each([
	{ legacyId: 58, recency: false, masters: false },
	{ legacyId: 58, recency: false, masters: true },
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
				if (legacyId >= 59 || masters) {
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

				yield* sql`CREATE TABLE collaboration_teams (id TEXT PRIMARY KEY, name TEXT, created_at TEXT, updated_at TEXT)`;
				if (!(legacyId === 58 && masters)) {
					yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${legacyId}, 'collaboration_foundation')`;
				}
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
						yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id BETWEEN 58 AND 64 ORDER BY migration_id`,
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

it.each([
	63, 65, 87,
])("preserves Masters from preview migration %i while applying main migrations", async (legacyId) => {
	const sqlite = sqliteLayer({ filename: ":memory:" });
	const runtime = ManagedRuntime.make(sqlite);
	try {
		await runtime.runPromise(
			Effect.void.pipe(
				Effect.provide(
					legacyId === 87
						? MigrationsThrough0086Live
						: MigrationsThrough0062Live,
				),
			),
		);
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				if (legacyId === 65) {
					yield* Migration0063ProjectWorkspaceKey;
					yield* Migration0064ProviderAccounts;
					yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (63, 'project_workspace_key'), (64, 'provider_accounts')`;
				}
				yield* Migration0065Masters;
				yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${legacyId}, 'masters')`;
				yield* sql`INSERT INTO masters (id, revision, state_json) VALUES ('saved-master', 7, '{"name":"Preserved"}')`;
				yield* sql`INSERT INTO master_artifacts VALUES ('saved-master','memory/testing.md',1,'durable evidence')`;
				yield* sql`INSERT INTO master_revisions VALUES ('saved-master',7,'historical policy')`;
				yield* sql`INSERT INTO master_commands (command_id,master_id,fingerprint,result_json,created_at) VALUES ('saved-command','saved-master','fingerprint','receipt',1)`;
			}),
		);
		for (let restart = 0; restart < 2; restart++) {
			await runtime.runPromise(
				Effect.void.pipe(Effect.provide(MigrationsLive)),
			);
		}
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				expect(
					yield* sql`SELECT id, revision, state_json FROM masters`,
				).toEqual([
					{
						id: "saved-master",
						revision: 7,
						state_json: '{"name":"Preserved"}',
					},
				]);
				const columns = yield* sql<{
					name: string;
				}>`PRAGMA table_info(projects)`;
				expect(columns.some((column) => column.name === "workspace_key")).toBe(
					true,
				);
				expect(
					yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id IN (63,64,87,88,89,90) ORDER BY migration_id`,
				).toEqual([
					{ migration_id: 63, name: "project_workspace_key" },
					{ migration_id: 64, name: "provider_accounts" },
					{ migration_id: 87, name: "scratch_folders" },
					{ migration_id: 88, name: "scratch_folders_repair" },
					{ migration_id: 89, name: "device_bridge_enrollment" },
					{ migration_id: 90, name: "masters" },
				]);
				expect(yield* sql`SELECT * FROM provider_accounts`).toEqual([]);
				expect(yield* sql`SELECT content FROM master_artifacts`).toEqual([
					{ content: "durable evidence" },
				]);
				expect(yield* sql`SELECT state_json FROM master_revisions`).toEqual([
					{ state_json: "historical policy" },
				]);
				expect(yield* sql`SELECT result_json FROM master_commands`).toEqual([
					{ result_json: "receipt" },
				]);
				expect(
					(yield* sql<{ name: string }>`PRAGMA table_info(projects)`).some(
						(column) => column.name === "kind",
					),
				).toBe(true);
			}),
		);
	} finally {
		await runtime.dispose();
	}
});

it.each([
	false,
	true,
])("preserves a populated main ledger with repaired preview=%s across restarts", async (preview) => {
	const sqlite = sqliteLayer({ filename: ":memory:" });
	const runtime = ManagedRuntime.make(sqlite);
	try {
		await runtime.runPromise(
			Effect.void.pipe(Effect.provide(MigrationsThrough0086Live)),
		);
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				if (preview) {
					yield* Migration0065Masters;
					yield* sql`INSERT INTO effect_sql_migrations (migration_id,name) VALUES (87,'masters')`;
					yield* sql`INSERT INTO masters VALUES ('preserved-master',1,'preserved state')`;
				} else {
					yield* Migration0087ScratchFolders;
					yield* sql`INSERT INTO effect_sql_migrations (migration_id,name) VALUES (87,'scratch_folders')`;
				}
				yield* Migration0088ScratchFoldersRepair;
				yield* Migration0089DeviceBridgeEnrollment;
				yield* sql`INSERT INTO effect_sql_migrations (migration_id,name) VALUES (88,'scratch_folders_repair'),(89,'device_bridge_enrollment')`;
				yield* sql`INSERT INTO projects (id,path,name,created_at,updated_at,kind) VALUES ('saved-project','/saved','Saved','2026-10-01','2026-10-01','scratch')`;
				yield* sql`INSERT INTO device_bridge_enrollment VALUES ('saved-account','saved-secret',0)`;
			}),
		);
		for (let restart = 0; restart < 2; restart++) {
			await runtime.runPromise(
				Effect.void.pipe(Effect.provide(MigrationsLive)),
			);
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					expect(yield* sql`SELECT id,kind FROM projects`).toEqual([
						{ id: "saved-project", kind: "scratch" },
					]);
					expect(
						yield* sql`SELECT account_id,secret,enabled FROM device_bridge_enrollment`,
					).toEqual([
						{ account_id: "saved-account", secret: "saved-secret", enabled: 0 },
					]);
					expect(yield* sql`SELECT id FROM masters`).toEqual(
						preview ? [{ id: "preserved-master" }] : [],
					);
					expect(
						yield* sql`SELECT migration_id,name FROM effect_sql_migrations WHERE migration_id >= 87 ORDER BY migration_id`,
					).toEqual([
						{ migration_id: 87, name: "scratch_folders" },
						{ migration_id: 88, name: "scratch_folders_repair" },
						{ migration_id: 89, name: "device_bridge_enrollment" },
						{ migration_id: 90, name: "masters" },
						{ migration_id: 91, name: "master_event_index" },
					]);
				}),
			);
		}
	} finally {
		await runtime.dispose();
	}
});

it("leaves an unknown Masters preview ledger and data intact when recovery fails", async () => {
	const sqlite = sqliteLayer({ filename: ":memory:" });
	const runtime = ManagedRuntime.make(sqlite);
	try {
		await runtime.runPromise(
			Effect.void.pipe(Effect.provide(MigrationsThrough0086Live)),
		);
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* Migration0065Masters;
				yield* sql`INSERT INTO effect_sql_migrations (migration_id,name) VALUES (87,'masters'),(88,'unknown_preview')`;
				yield* sql`INSERT INTO masters VALUES ('saved-master',1,'preserved')`;
			}),
		);
		await expect(
			runtime.runPromise(Effect.void.pipe(Effect.provide(MigrationsLive))),
		).rejects.toThrow("Unrecognized migration history after Masters preview");
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				expect(
					yield* sql`SELECT migration_id,name FROM effect_sql_migrations WHERE migration_id >= 87 ORDER BY migration_id`,
				).toEqual([
					{ migration_id: 87, name: "masters" },
					{ migration_id: 88, name: "unknown_preview" },
				]);
				expect(yield* sql`SELECT state_json FROM masters`).toEqual([
					{ state_json: "preserved" },
				]);
			}),
		);
	} finally {
		await runtime.dispose();
	}
});

it("rolls back a failed preview repair before retrying on restart", async () => {
	const sqlite = sqliteLayer({ filename: ":memory:" });
	const runtime = ManagedRuntime.make(sqlite);
	try {
		await runtime.runPromise(
			Effect.void.pipe(Effect.provide(MigrationsThrough0086Live)),
		);
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* Migration0065Masters;
				yield* sql`INSERT INTO effect_sql_migrations (migration_id,name) VALUES (87,'masters')`;
				yield* sql`INSERT INTO masters VALUES ('saved-master',1,'preserved')`;
				yield* sql`CREATE TRIGGER fail_preview_repair BEFORE INSERT ON effect_sql_migrations WHEN NEW.migration_id = 89 BEGIN SELECT RAISE(ABORT, 'simulated migration interruption'); END`;
			}),
		);
		await expect(
			runtime.runPromise(Effect.void.pipe(Effect.provide(MigrationsLive))),
		).rejects.toThrow();
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				expect(
					yield* sql`SELECT migration_id,name FROM effect_sql_migrations WHERE migration_id >= 87`,
				).toEqual([{ migration_id: 87, name: "masters" }]);
				expect(
					(yield* sql<{ name: string }>`PRAGMA table_info(projects)`).some(
						(column) => column.name === "kind",
					),
				).toBe(false);
				expect(yield* sql`SELECT state_json FROM masters`).toEqual([
					{ state_json: "preserved" },
				]);
				yield* sql`DROP TRIGGER fail_preview_repair`;
			}),
		);
		for (let restart = 0; restart < 2; restart++)
			await runtime.runPromise(
				Effect.void.pipe(Effect.provide(MigrationsLive)),
			);
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				expect(
					yield* sql`SELECT migration_id,name FROM effect_sql_migrations WHERE migration_id = 90`,
				).toEqual([{ migration_id: 90, name: "masters" }]);
				expect(yield* sql`SELECT state_json FROM masters`).toEqual([
					{ state_json: "preserved" },
				]);
			}),
		);
	} finally {
		await runtime.dispose();
	}
});
