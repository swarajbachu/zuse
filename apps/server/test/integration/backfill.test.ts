import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeSessionDomain } from "@zuse/domain/engine/session-domain";
import { makeSqlSessionQueries } from "@zuse/domain/queries/sql-session-queries";
import { layer as nodeSqliteLayer } from "@zuse/sqlite";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";
import { runLifecycleBackfill } from "../../src/persistence/backfill.ts";
import { Migration0030CqrsEngine } from "../../src/persistence/migrations/0030_cqrs_engine.ts";
import { Migration0031BackfillRuns } from "../../src/persistence/migrations/0031_backfill_runs.ts";

describe("lifecycle backfill", () => {
	test("appends missing lifecycle events once and advances all cursors", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-backfill-"));
		const filename = join(directory, "test.sqlite");
		const seed = new DatabaseSync(filename);
		seed.exec(`
			CREATE TABLE chats (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				worktree_id TEXT,
				title TEXT NOT NULL,
				title_provenance TEXT NOT NULL DEFAULT 'manual',
				active_session_id TEXT,
				origin_session_id TEXT,
				archived_at TEXT,
				archived_worktree_json TEXT,
				last_message_at TEXT,
				last_read_at TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
			);
			CREATE TABLE sessions (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				chat_id TEXT NOT NULL,
				title TEXT NOT NULL,
				title_provenance TEXT NOT NULL DEFAULT 'manual',
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
				queue_paused INTEGER NOT NULL DEFAULT 0,
				archived_at TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
			);
			CREATE TABLE messages (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				turn_id TEXT,
				role TEXT NOT NULL,
				kind TEXT NOT NULL,
				content_json TEXT NOT NULL,
				parent_item_id TEXT,
				created_at TEXT NOT NULL,
				sequence INTEGER
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
			INSERT INTO chats
				(id, project_id, title, last_message_at, last_read_at, created_at)
			VALUES (
				'chat-1', 'project-1', 'Existing title',
				'2026-01-02T00:00:00.000Z',
				'2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
			);
			INSERT INTO sessions
				(id, project_id, chat_id, title, archived_at, created_at)
			VALUES (
				'session-1', 'project-1', 'chat-1', 'Existing title',
				'2026-01-03T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
			);
			INSERT INTO messages VALUES (
				'message-1', 'session-1', NULL, 'user', 'text',
				'{"spacing":  "preserved"}', NULL, '2026-01-02T00:00:00.000Z', 1
			);
			INSERT INTO events
				(event_id, stream_kind, stream_id, stream_version, type, occurred_at, actor, payload_json)
			VALUES
			(
				'backfill:message-1', 'session', 'session-1', 1,
				'MessagePersisted', '2026-01-02T00:00:00.000Z', NULL,
				'{"messageId":"message-1"}'
			),
			(
				'random-pre-lifecycle-message', 'session', 'session-1', 2,
				'MessagePersisted', '2026-01-02T00:00:00.000Z', 'user',
				'{"messageId":"message-1","createdAt":"2026-01-02T00:00:00.000Z"}'
			),
			(
				'backfill:chat-created:chat-1', 'chat', 'chat-1', 1,
				'ChatCreated', '2026-01-01T00:00:00.000Z', 'backfill',
				'{"_tag":"ChatCreated","chatId":"chat-1","projectId":"project-1","worktreeId":null,"title":"Existing title","originSessionId":null,"lastReadAt":1767225600000,"createdAt":1767225600000}'
			),
			(
				'backfill:session-created:session-1', 'session', 'session-1', 3,
				'SessionCreated', '2026-01-01T00:00:00.000Z', 'backfill',
				'{"_tag":"SessionCreated","sessionId":"session-1","chatId":"chat-1","projectId":"project-1","createdAt":1767225600000}'
			),
			(
				'backfill:session-title:session-1', 'session', 'session-1', 4,
				'SessionTitleSet', '2026-01-01T00:00:00.000Z', 'backfill',
				'{"_tag":"SessionTitleSet","title":"Existing title","updatedAt":1767225600000}'
			),
			(
				'backfill:orphan-message', 'session', 'deleted-session', 1,
				'MessagePersisted', '2025-12-31T00:00:00.000Z', 'backfill',
				'{"messageId":"orphan-message","createdAt":"2025-12-31T00:00:00.000Z"}'
			),
			(
				'random-orphan-event', 'session', 'deleted-session', 2,
				'MessagePersisted', '2025-12-31T00:00:01.000Z', 'user',
				'{"messageId":"random-orphan","createdAt":"2025-12-31T00:00:01.000Z"}'
			),
			(
				'durable-unprojected-message', 'session', 'session-1', 5,
				'MessagePersisted', '2026-01-02T00:00:01.000Z', NULL,
				'{"_tag":"MessagePersisted","messageId":"message-2","turnId":null,"role":"assistant","kind":"text","contentJson":"{\\"_tag\\":\\"assistant\\",\\"text\\":\\"durable\\"}","parentItemId":null,"createdAt":1767312001000}'
			);
			INSERT INTO app_state VALUES ('projector_watermark', '7');
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
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
						INSERT INTO command_receipts
							(command_id, stream_kind, stream_id, stream_version,
							 event_ids_json, result_json, created_at)
						VALUES
							('durable-command', 'session', 'session-1', 5,
							 '["durable-unprojected-message"]',
							 '{"commandId":"durable-command","streamId":"session-1","streamVersion":5,"eventIds":["durable-unprojected-message"]}',
							 '2026-01-02T00:00:01.000Z')
					`;
					yield* sql`
						INSERT INTO backfill_runs
							(backfill_name, status, started_at, completed_at, event_count)
						VALUES
							('conversation-lifecycle-v4', 'completed',
							 '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z', 4)
					`;
					return yield* runLifecycleBackfill;
				}),
			);
			expect(result).toEqual({ status: "completed", eventCount: 5 });

			const snapshot = await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const domain = yield* makeSessionDomain(sql, () =>
						Effect.succeed("unused-event-id"),
					);
					yield* domain.catchUp;
					const queriedMessages =
						yield* makeSqlSessionQueries(sql).messages("session-1");
					const events = yield* sql<{
						readonly type: string;
						readonly stream_kind: string;
						readonly stream_version: number;
						readonly payload_json: string;
					}>`SELECT type, stream_kind, stream_version, payload_json FROM events ORDER BY sequence`;
					const cursors = yield* sql<{
						readonly projector_name: string;
						readonly last_sequence: number;
					}>`SELECT projector_name, last_sequence FROM projector_cursors ORDER BY projector_name`;
					const receipts = yield* sql<{
						readonly stream_version: number;
						readonly result_json: string;
					}>`
						SELECT stream_version, result_json FROM command_receipts
						WHERE command_id = 'durable-command'
					`;
					const rerun = yield* runLifecycleBackfill;
					return { events, cursors, queriedMessages, receipts, rerun };
				}),
			);

			expect(
				snapshot.events.map(({ type, stream_kind, stream_version }) => ({
					type,
					stream_kind,
					stream_version,
				})),
			).toEqual([
				{ type: "ChatCreated", stream_kind: "chat", stream_version: 1 },
				{ type: "SessionCreated", stream_kind: "session", stream_version: 1 },
				{ type: "MessagePersisted", stream_kind: "session", stream_version: 2 },
				{ type: "MessagePersisted", stream_kind: "session", stream_version: 3 },
				{ type: "SessionArchived", stream_kind: "session", stream_version: 4 },
				{ type: "SessionTitleSet", stream_kind: "session", stream_version: 5 },
				{
					type: "ChatActiveSessionSet",
					stream_kind: "chat",
					stream_version: 2,
				},
				{
					type: "ChatLastMessageSet",
					stream_kind: "chat",
					stream_version: 3,
				},
			]);
			expect(
				snapshot.queriedMessages.map((message) => message.messageId),
			).toEqual(["message-2", "message-1"]);
			const messagePayload = snapshot.events[3]?.payload_json;
			expect(messagePayload).toBeDefined();
			expect(JSON.parse(messagePayload ?? "null")).toEqual({
				_tag: "MessagePersisted",
				messageId: "message-1",
				turnId: null,
				role: "user",
				kind: "text",
				contentJson: '{"spacing":  "preserved"}',
				parentItemId: null,
				createdAt: Date.parse("2026-01-02T00:00:00.000Z"),
			});
			const lastMessagePayload = snapshot.events[7]?.payload_json;
			expect(lastMessagePayload).toBeDefined();
			expect(JSON.parse(lastMessagePayload ?? "null")).toEqual({
				_tag: "ChatLastMessageSet",
				messageAt: Date.parse("2026-01-02T00:00:01.000Z"),
			});
			expect(snapshot.cursors).toEqual([
				{ projector_name: "chat-read-model", last_sequence: 13 },
				{ projector_name: "messages", last_sequence: 13 },
				{ projector_name: "reactor:auto-name-chat", last_sequence: 13 },
				{ projector_name: "reactor:chat-archive", last_sequence: 13 },
				{ projector_name: "reactor:chat-delete", last_sequence: 13 },
				{
					projector_name: "reactor:permission-lifecycle",
					last_sequence: 13,
				},
				{ projector_name: "reactor:provider-start", last_sequence: 13 },
				{ projector_name: "reactor:provider-stop", last_sequence: 13 },
				{ projector_name: "session-read-model", last_sequence: 13 },
			]);
			expect(snapshot.receipts).toHaveLength(1);
			expect(snapshot.receipts[0]?.stream_version).toBe(2);
			expect(
				JSON.parse(snapshot.receipts[0]?.result_json ?? "null"),
			).toMatchObject({ streamVersion: 2 });
			expect(snapshot.rerun).toEqual({
				status: "already-completed",
				eventCount: 5,
			});
		} finally {
			await runtime.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
