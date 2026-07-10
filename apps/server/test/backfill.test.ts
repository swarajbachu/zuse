import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";

import { runLifecycleBackfill } from "../src/persistence/backfill.ts";
import { Migration0030CqrsEngine } from "../src/persistence/migrations/0030_cqrs_engine.ts";
import { Migration0031BackfillRuns } from "../src/persistence/migrations/0031_backfill_runs.ts";
import { layer as nodeSqliteLayer } from "../src/persistence/node-sqlite-client.ts";

describe("lifecycle backfill", () => {
	test("appends missing lifecycle events once and advances all cursors", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-backfill-"));
		const filename = join(directory, "test.sqlite");
		const seed = new DatabaseSync(filename);
		seed.exec(`
			CREATE TABLE sessions (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				chat_id TEXT NOT NULL,
				title TEXT NOT NULL,
				provider_id TEXT NOT NULL DEFAULT 'provider-1',
				model TEXT NOT NULL DEFAULT 'model-1',
				status TEXT NOT NULL DEFAULT 'idle',
				cursor TEXT,
				resume_strategy TEXT NOT NULL DEFAULT 'none',
				runtime_mode TEXT NOT NULL DEFAULT 'approval-required',
				agents_json TEXT,
				worktree_id TEXT,
				forked_from_session_id TEXT,
				forked_from_message_id TEXT,
				permission_mode TEXT NOT NULL DEFAULT 'default',
				tool_search INTEGER NOT NULL DEFAULT 0,
				archived_at TEXT,
				created_at TEXT NOT NULL
			);
			CREATE TABLE messages (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				role TEXT NOT NULL,
				kind TEXT NOT NULL,
				content_json TEXT NOT NULL,
				parent_item_id TEXT,
				created_at TEXT NOT NULL
			);
			CREATE TABLE events (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				event_id TEXT NOT NULL UNIQUE,
				stream_kind TEXT NOT NULL,
				stream_id TEXT NOT NULL,
				stream_version INTEGER NOT NULL,
				type TEXT NOT NULL,
				occurred_at TEXT NOT NULL,
				actor TEXT,
				payload_json TEXT NOT NULL,
				UNIQUE (stream_kind, stream_id, stream_version)
			);
			CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			INSERT INTO sessions
				(id, project_id, chat_id, title, archived_at, created_at)
			VALUES (
				'session-1', 'project-1', 'chat-1', 'Existing title',
				'2026-01-03T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
			);
			INSERT INTO messages VALUES (
				'message-1', 'session-1', 'user', 'text',
				'{"spacing":  "preserved"}', NULL, '2026-01-02T00:00:00.000Z'
			);
			INSERT INTO events
				(event_id, stream_kind, stream_id, stream_version, type, occurred_at, actor, payload_json)
			VALUES (
				'backfill:message-1', 'session', 'session-1', 1,
				'MessagePersisted', '2026-01-02T00:00:00.000Z', NULL,
				'{"messageId":"message-1"}'
			);
			INSERT INTO app_state VALUES ('projector_watermark', '1');
		`);
		seed.close();

		const runtime = ManagedRuntime.make(
			nodeSqliteLayer({ filename, disableWAL: true }),
		);
		try {
			const result = await runtime.runPromise(
				Effect.gen(function* () {
					yield* Migration0030CqrsEngine;
					yield* Migration0031BackfillRuns;
					return yield* runLifecycleBackfill;
				}),
			);
			expect(result).toEqual({ status: "completed", eventCount: 3 });

			const snapshot = await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const events = yield* sql<{
						readonly type: string;
						readonly stream_version: number;
						readonly payload_json: string;
					}>`SELECT type, stream_version, payload_json FROM events ORDER BY sequence`;
					const cursors = yield* sql<{
						readonly projector_name: string;
						readonly last_sequence: number;
					}>`SELECT projector_name, last_sequence FROM projector_cursors ORDER BY projector_name`;
					const rerun = yield* runLifecycleBackfill;
					return { events, cursors, rerun };
				}),
			);

			expect(
				snapshot.events.map(({ type, stream_version }) => ({
					type,
					stream_version,
				})),
			).toEqual([
				{ type: "MessagePersisted", stream_version: 1 },
				{ type: "SessionCreated", stream_version: 2 },
				{ type: "SessionTitleSet", stream_version: 3 },
				{ type: "SessionArchived", stream_version: 4 },
			]);
			const firstPayload = snapshot.events[0]?.payload_json;
			expect(firstPayload).toBeDefined();
			expect(JSON.parse(firstPayload ?? "null")).toEqual({
				_tag: "MessagePersisted",
				messageId: "message-1",
				turnId: null,
				role: "user",
				kind: "text",
				contentJson: '{"spacing":  "preserved"}',
				parentItemId: null,
				createdAt: Date.parse("2026-01-02T00:00:00.000Z"),
			});
			expect(snapshot.cursors).toEqual([
				{ projector_name: "activity", last_sequence: 4 },
				{ projector_name: "chats", last_sequence: 4 },
				{ projector_name: "messages", last_sequence: 4 },
				{ projector_name: "sessions", last_sequence: 4 },
			]);
			expect(snapshot.rerun).toEqual({
				status: "already-completed",
				eventCount: 3,
			});
		} finally {
			await runtime.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
