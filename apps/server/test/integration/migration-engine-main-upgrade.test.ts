import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import {
	LegacyMigrationsThrough0083Live,
	MigrationsLive,
	MigrationsThrough0064Live,
	MigrationsThrough0073Live,
} from "../../src/persistence/migrations.ts";

const runtime = (filename: string, migrations = MigrationsLive) => {
	const sqlite = sqliteLayer({ filename, disableWAL: true });
	return ManagedRuntime.make(
		Layer.merge(sqlite, migrations.pipe(Layer.provide(sqlite))),
	);
};

const seedConversation = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`INSERT INTO projects (id,path,name,created_at,updated_at) VALUES ('project-1','/tmp/retained','Retained','2026-10-01','2026-10-01')`;
	yield* sql`INSERT INTO chats (id,project_id,title,created_at,updated_at) VALUES ('chat-1','project-1','Chat','2026-10-01','2026-10-01')`;
	yield* sql`INSERT INTO sessions (id,project_id,title,provider_id,model,status,chat_id,queue_paused,created_at,updated_at) VALUES ('session-1','project-1','Chat','codex','gpt','idle','chat-1',1,'2026-10-01','2026-10-01')`;
	yield* sql`INSERT INTO messages (id,session_id,role,kind,content_json,created_at) VALUES ('message-1','session-1','user','text','{"text":"preserved"}','2026-10-01')`;
	yield* sql`INSERT INTO queued_messages (id,session_id,queue_order,input_json,created_at,updated_at) VALUES ('queue-1','session-1',0,'{"text":"do not resend"}','2026-10-01','2026-10-01')`;
});

const verifyConversation = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	expect(yield* sql`SELECT id,queue_paused FROM sessions`).toEqual([
		{ id: "session-1", queue_paused: 1 },
	]);
	expect(yield* sql`SELECT id FROM chats`).toEqual([{ id: "chat-1" }]);
	expect(yield* sql`SELECT id,content_json FROM messages`).toEqual([
		{ id: "message-1", content_json: '{"text":"preserved"}' },
	]);
	expect(yield* sql`SELECT id,input_json FROM queued_messages`).toEqual([
		{ id: "queue-1", input_json: '{"text":"do not resend"}' },
	]);
	expect(yield* sql`PRAGMA integrity_check`).toEqual([
		{ integrity_check: "ok" },
	]);
	expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
});

it("upgrades main while preserving harness executions and encrypted model records", async () => {
	const directory = mkdtempSync(join(tmpdir(), "zuse-main-upgrade-"));
	const filename = join(directory, "db.sqlite");
	const previous = runtime(filename, MigrationsThrough0064Live);
	try {
		await previous.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* seedConversation;
				yield* sql`UPDATE projects SET workspace_key = 'organization:retained' WHERE id = 'project-1'`;
				yield* sql`INSERT INTO provider_accounts VALUES ('account-1', 'codex', 'Work', 1, 42)`;
				yield* sql`INSERT INTO session_provider_accounts VALUES ('session-1', 'codex', 'account-1')`;
				yield* sql`INSERT INTO harness_executions VALUES ('root', 7, '{"state":"waiting"}', '2026-10-01')`;
				yield* sql`INSERT INTO model_connection_secrets VALUES ('local', 'connection', 'encrypted', 42)`;
			}),
		);
		await previous.dispose();
		const upgraded = runtime(filename);
		try {
			await upgraded.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					expect(yield* sql`SELECT * FROM harness_executions`).toEqual([
						{
							root_id: "root",
							revision: 7,
							state_json: '{"state":"waiting"}',
							updated_at: "2026-10-01",
						},
					]);
					expect(
						yield* sql`SELECT envelope FROM model_connection_secrets`,
					).toEqual([{ envelope: "encrypted" }]);
					expect(
						yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 61 ORDER BY migration_id`,
					).toEqual([
						{ migration_id: 61, name: "harness_executions" },
						{ migration_id: 62, name: "model_connections" },
						{ migration_id: 63, name: "project_workspace_key" },
						{ migration_id: 64, name: "provider_accounts" },
						{ migration_id: 65, name: "jobs" },
						{ migration_id: 66, name: "session_graph" },
						{ migration_id: 67, name: "provider_thread_ownership" },
						{ migration_id: 68, name: "job_attempt_ownership" },
						{ migration_id: 69, name: "provider_reservations" },
						{ migration_id: 70, name: "attempt_history" },
						{ migration_id: 71, name: "attempt_provider_turn" },
						{ migration_id: 72, name: "ingestion_leases" },
						{ migration_id: 73, name: "session_inputs" },
						{ migration_id: 74, name: "input_ownership" },
						{ migration_id: 75, name: "question_expiry" },
						{ migration_id: 76, name: "plan_deliveries" },
						{ migration_id: 77, name: "context_handoffs" },
						{ migration_id: 78, name: "turn_activity_index" },
						{ migration_id: 79, name: "fork_constructions" },
						{ migration_id: 80, name: "session_checkpoints" },
						{ migration_id: 81, name: "context_links" },
						{ migration_id: 82, name: "session_delegations" },
						{ migration_id: 83, name: "provider_contexts" },
						{ migration_id: 84, name: "execution_steps" },
						{ migration_id: 85, name: "native_checkpoint_history" },
						{ migration_id: 86, name: "automation" },
						{ migration_id: 87, name: "scratch_folders" },
						{ migration_id: 88, name: "scratch_folders_repair" },
						{ migration_id: 89, name: "device_bridge_enrollment" },
						{ migration_id: 90, name: "masters" },
						{ migration_id: 91, name: "master_event_index" },
						{ migration_id: 92, name: "review_guides" },
					]);
					expect(yield* sql`SELECT * FROM device_bridge_enrollment`).toEqual(
						[],
					);
					expect(yield* sql`SELECT * FROM jobs`).toEqual([]);
					expect(yield* sql`SELECT workspace_key FROM projects`).toEqual([
						{ workspace_key: "organization:retained" },
					]);
					expect(
						yield* sql`SELECT account_id FROM session_provider_accounts`,
					).toEqual([{ account_id: "account-1" }]);
					expect(yield* sql`SELECT name FROM provider_accounts`).toEqual([
						{ name: "Work" },
					]);
					yield* verifyConversation;
					const plan = yield* sql<{
						detail: string;
					}>`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM session_turns WHERE status IN ('starting', 'running')`;
					expect(
						plan.some((row) => row.detail.includes("idx_session_turns_status")),
					).toBe(true);
				}),
			);
		} finally {
			await upgraded.dispose();
		}
	} finally {
		await previous.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});

it.each([
	{ boundary: 63, full: true, unknown: false, interrupted: true },
	{ boundary: 61, full: false, unknown: false, interrupted: false },
	{ boundary: 61, full: false, unknown: true, interrupted: false },
	{ boundary: 63, full: false, unknown: false, interrupted: false },
	{ boundary: 63, full: true, unknown: false, interrupted: false },
	{ boundary: 63, full: true, unknown: true, interrupted: false },
])("repairs unpublished engine ledger $boundary (full: $full, unknown: $unknown, interrupted: $interrupted)", async ({
	boundary,
	full,
	unknown,
	interrupted,
}) => {
	const directory = mkdtempSync(join(tmpdir(), "zuse-engine-upgrade-"));
	const filename = join(directory, "db.sqlite");
	const previous = runtime(
		filename,
		full ? LegacyMigrationsThrough0083Live : MigrationsThrough0073Live,
	);
	try {
		await previous.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;

				if (boundary === 61) {
					yield* sql`DROP TABLE harness_executions`;
					yield* sql`DROP TABLE model_connection_secrets`;
					yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id IN (61,62)`;
					const rows = yield* sql<{
						migration_id: number;
					}>`SELECT migration_id FROM effect_sql_migrations WHERE migration_id >= 63 ORDER BY migration_id`;
					for (const row of rows)
						yield* sql`UPDATE effect_sql_migrations SET migration_id = ${row.migration_id - 2} WHERE migration_id = ${row.migration_id}`;
				}
				yield* seedConversation;
				yield* sql`INSERT INTO jobs (id, session_id, kind, request_json, status, available_at, created_at, updated_at) VALUES ('retained', 'session-1', 'stop-session', '{}', 'pending', '2026-10-01', '2026-10-01', '2026-10-01')`;
				if (unknown)
					yield* sql`UPDATE effect_sql_migrations SET name = 'unknown' WHERE migration_id = ${boundary + 8}`;
				if (interrupted)
					yield* sql`CREATE TRIGGER fail_repair BEFORE UPDATE OF migration_id ON effect_sql_migrations BEGIN SELECT RAISE(ABORT, 'injected repair failure'); END`;
			}),
		);
		await previous.dispose();
		const upgraded = runtime(filename);
		try {
			if (unknown || interrupted) {
				await expect(upgraded.runPromise(Effect.void)).rejects.toThrow(
					unknown
						? "Unrecognized migration history"
						: "injected repair failure",
				);
			} else {
				await upgraded.runPromise(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						expect(yield* sql`SELECT id FROM jobs`).toEqual([
							{ id: "retained" },
						]);
						expect(
							yield* sql`SELECT migration_id FROM effect_sql_migrations WHERE name = 'jobs'`,
						).toEqual([{ migration_id: 65 }]);
						yield* verifyConversation;
						expect(yield* sql`SELECT workspace_key FROM projects`).toEqual([
							{ workspace_key: "personal" },
						]);
						expect(
							yield* sql`SELECT session_id,provider_id,account_id FROM session_provider_accounts`,
						).toEqual([
							{
								session_id: "session-1",
								provider_id: "codex",
								account_id: null,
							},
						]);
						expect(yield* sql`SELECT * FROM harness_executions`).toEqual([]);
						expect(yield* sql`SELECT * FROM model_connection_secrets`).toEqual(
							[],
						);
					}),
				);
			}
		} finally {
			await upgraded.dispose();
		}
		if (!unknown && !interrupted) {
			const reopened = runtime(filename);
			try {
				await reopened.runPromise(verifyConversation);
			} finally {
				await reopened.dispose();
			}
		}
		if (unknown || interrupted) {
			const raw = ManagedRuntime.make(
				sqliteLayer({ filename, disableWAL: true }),
			);
			try {
				await raw.runPromise(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						expect(
							yield* sql`SELECT migration_id FROM effect_sql_migrations WHERE name = 'jobs'`,
						).toEqual([{ migration_id: boundary }]);
						if (boundary === 61)
							expect(
								yield* sql`SELECT name FROM sqlite_master WHERE name IN ('harness_executions','model_connection_secrets')`,
							).toEqual([]);
						expect(
							yield* sql`SELECT name FROM sqlite_master WHERE name = 'provider_accounts'`,
						).toEqual([]);
						const columns = yield* sql<{
							name: string;
						}>`PRAGMA table_info(projects)`;
						expect(
							columns.some((column) => column.name === "workspace_key"),
						).toBe(false);
						expect(yield* sql`SELECT id FROM jobs`).toEqual([
							{ id: "retained" },
						]);
						yield* verifyConversation;
						if (interrupted) yield* sql`DROP TRIGGER fail_repair`;
					}),
				);
			} finally {
				await raw.dispose();
			}
		}
		if (interrupted) {
			const retry = runtime(filename);
			try {
				await retry.runPromise(verifyConversation);
			} finally {
				await retry.dispose();
			}
		}
	} finally {
		await previous.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});
