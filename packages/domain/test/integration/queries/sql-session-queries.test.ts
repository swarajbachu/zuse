import { MAX_SESSION_QUEUE_TOTAL_BYTES, SessionId } from "@zuse/contracts";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";
import {
	MAX_TIMELINE_SNAPSHOT_PROJECTION_BYTES,
	readSessionTimelineSnapshot,
} from "../../../src/queries/session-timeline-snapshot.js";
import {
	makeSqlSessionQueries,
	SessionQueryDecodeError,
} from "../../../src/queries/sql-session-queries.js";
import { createDomainTestSchema } from "../../../src/test/sql-schema.js";

const run = <A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient>) =>
	Effect.runPromise(
		program.pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);

describe("SqlSessionQueries", () => {
	test("lists sessions and pages messages by durable sequence", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO sessions
						(id, project_id, title, provider_id, model, status, archived_at,
						 cursor, resume_strategy, runtime_mode, agents_json, worktree_id,
						 chat_id, forked_from_session_id, forked_from_message_id,
						 permission_mode, tool_search, created_at, updated_at)
					VALUES
						('session-1', 'project-1', 'Title', 'claude', 'model', 'idle',
						 NULL, NULL, 'none', 'approval-required', NULL, NULL, 'chat-1',
						 NULL, NULL, 'default', 0, '2026-01-01T00:00:00.000Z',
						 '2026-01-02T00:00:00.000Z')
				`;
				yield* sql`
					INSERT INTO messages
						(id, session_id, role, kind, content_json, parent_item_id,
						 created_at, sequence)
					VALUES
						('message-1', 'session-1', 'user', 'user', '{"_tag":"user","text":"hi","goal":false}',
						 NULL, '2026-01-03T00:00:00.000Z', 5),
						('message-2', 'session-1', 'assistant', 'assistant', '{"_tag":"assistant","text":"hello"}',
						 NULL, '2026-01-04T00:00:00.000Z', 6)
				`;
				const queries = makeSqlSessionQueries(sql);
				return {
					list: yield* queries.list({ projectId: "project-1" }),
					page: yield* queries.messagePage({
						sessionId: "session-1",
						limit: 1,
					}),
				};
			}),
		);

		expect(result.list).toEqual([
			expect.objectContaining({
				sessionId: "session-1",
				updatedAt: Date.parse("2026-01-02T00:00:00.000Z"),
			}),
		]);
		expect(result.page).toMatchObject({
			items: [expect.objectContaining({ messageId: "message-2", sequence: 6 })],
			olderSequence: 6,
		});
	});

	test("fails malformed persisted timestamps at the query boundary", async () => {
		const exit = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO sessions
						(id, project_id, title, provider_id, model, status, resume_strategy,
						 runtime_mode, chat_id, permission_mode, tool_search, created_at, updated_at)
					VALUES
						('bad', 'project-1', 'Bad', 'claude', 'model', 'idle', 'none',
						 'approval-required', 'chat-1', 'default', 0, 'invalid', 'invalid')
				`;
				return yield* Effect.exit(makeSqlSessionQueries(sql).get("bad"));
			}),
		);

		expect(exit._tag).toBe("Failure");
		if (exit._tag === "Failure") {
			expect(String(exit.cause)).toContain(SessionQueryDecodeError.name);
		}
	});

	test("bounds the materialized latest-message snapshot below the sync budget", async () => {
		const snapshot = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO sessions
						(id, project_id, title, provider_id, model, status, resume_strategy,
						 runtime_mode, chat_id, permission_mode, tool_search, created_at, updated_at)
					VALUES
						('large', 'project-1', 'Large', 'claude', 'model', 'idle', 'none',
						 'approval-required', 'chat-1', 'default', 0,
						 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
				`;
				yield* Effect.forEach(
					[1, 2, 3, 4, 5, 6],
					(sequence) => {
						const content = JSON.stringify({
							_tag: "assistant",
							text: `${sequence}:${"x".repeat(220 * 1024)}`,
						});
						return sql`
						INSERT INTO messages
							(id, session_id, role, kind, content_json, parent_item_id,
							 created_at, sequence)
						VALUES (${`message-${sequence}`}, 'large', 'assistant', 'assistant',
							${content}, NULL, '2026-01-01T00:00:00.000Z', ${sequence})
					`;
					},
					{ discard: true },
				);
				return yield* readSessionTimelineSnapshot(sql, SessionId.make("large"));
			}),
		);

		expect(
			new TextEncoder().encode(JSON.stringify(snapshot.projection)).byteLength,
		).toBeLessThanOrEqual(MAX_TIMELINE_SNAPSHOT_PROJECTION_BYTES);
		expect(
			new TextEncoder().encode(
				JSON.stringify({
					kind: "snapshot",
					sessionId: "large",
					throughVersion: Number.MAX_SAFE_INTEGER,
					projection: snapshot.projection,
					cursor: {
						epoch: "00000000-0000-0000-0000-000000000000",
						version: Number.MAX_SAFE_INTEGER,
					},
					olderMessageSequence: snapshot.olderMessageSequence,
				}),
			).byteLength,
		).toBeLessThan(1024 * 1024);
		expect(snapshot.projection.messages.length).toBeLessThan(6);
		expect(snapshot.projection.messages.at(-1)?.id).toBe("message-6");
		expect(snapshot.olderMessageSequence).not.toBeNull();
	});

	test("fails closed when legacy queue data exceeds the snapshot budget", async () => {
		const exit = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO sessions
						(id, project_id, title, provider_id, model, status, resume_strategy,
						 runtime_mode, chat_id, permission_mode, tool_search, created_at, updated_at)
					VALUES
						('large-queue', 'project-1', 'Large queue', 'claude', 'model',
						 'running', 'none', 'approval-required', 'chat-1', 'default', 0,
						 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
				`;
				const inputJson = JSON.stringify({
					text: "x".repeat(MAX_SESSION_QUEUE_TOTAL_BYTES),
					attachments: [],
					fileRefs: [],
					skillRefs: [],
					annotations: [],
				});
				yield* sql`
					INSERT INTO queued_messages
						(id, session_id, queue_order, input_json, created_at, updated_at, ready)
					VALUES
						('large-item', 'large-queue', 0, ${inputJson},
						 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)
				`;
				return yield* Effect.exit(
					readSessionTimelineSnapshot(sql, SessionId.make("large-queue")),
				);
			}),
		);

		expect(exit._tag).toBe("Failure");
		if (exit._tag === "Failure") {
			expect(String(exit.cause)).toContain("bounded queue byte limit");
		}
	});
});
