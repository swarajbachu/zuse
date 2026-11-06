import { MAX_SESSION_QUEUE_TOTAL_BYTES, SessionId } from "@zuse/contracts";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";
import { projectSessionInput } from "../../../src/projectors/sql-input-projector.js";
import {
	MAX_TIMELINE_SNAPSHOT_PROJECTION_BYTES,
	readSessionTimelineSnapshot,
} from "../../../src/queries/session-timeline-snapshot.js";
import { readSessionMessageContent } from "../../../src/queries/session-timeline-wire.ts";
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
	test("reconstructs unresolved interactions outside the bounded message page", async () => {
		const snapshot = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO sessions
						(id, project_id, title, provider_id, model, status,
						 runtime_mode, chat_id, permission_mode, tool_search, created_at, updated_at)
					VALUES
						('interactions', 'project-1', 'Interactions', 'claude', 'model',
						 'running', 'approval-required', 'chat-1', 'default', 0,
						 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
				`;
				const question = JSON.stringify({
					_tag: "user_question",
					itemId: "question-old",
					questions: [{ question: "Choose", options: ["A"] }],
				});
				yield* sql`
					INSERT INTO messages
						(id, session_id, role, kind, content_json, parent_item_id,
						 created_at, sequence)
					VALUES
						('question-old', 'interactions', 'assistant', 'user_question',
						 ${question}, NULL, '2026-01-01T00:00:00.000Z', 1)
				`;
				yield* Effect.forEach(
					Array.from({ length: 100 }, (_, index) => index + 2),
					(sequence) => sql`
						INSERT INTO messages
							(id, session_id, role, kind, content_json, parent_item_id,
							 created_at, sequence)
						VALUES
							(${`later-${sequence}`}, 'interactions', 'assistant', 'assistant',
							 '{"_tag":"assistant","text":"later"}', NULL,
							 '2026-01-01T00:00:01.000Z', ${sequence})
					`,
					{ discard: true },
				);
				const request = JSON.stringify({
					id: "permission-old",
					sessionId: "interactions",
					kind: { _tag: "Bash", command: "git status" },
					requestedAt: "2026-01-01T00:00:00.000Z",
					forcePrompt: false,
				});
				const payload = JSON.stringify({
					_tag: "PermissionRequested",
					requestId: "permission-old",
					turnId: "turn-1",
					payloadJson: request,
					requestedAt: 1,
				});
				yield* sql`
					INSERT INTO events
						(event_id, stream_kind, stream_id, stream_version, type,
						 occurred_at, payload_json)
					VALUES
						('permission-requested', 'session', 'interactions', 1,
						 'PermissionRequested', '2026-01-01T00:00:00.000Z', ${payload})
				`;
				yield* projectSessionInput(sql, {
					streamId: "interactions",
					sequence: 1,
					event: {
						_tag: "MessagePersisted",
						messageId: "question-old",
						turnId: null,
						role: "assistant",
						kind: "user_question",
						contentJson: question,
						parentItemId: null,
						createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
					},
				});
				yield* projectSessionInput(sql, {
					streamId: "interactions",
					sequence: 102,
					event: {
						_tag: "PermissionRequested",
						requestId: "permission-old",
						turnId: "turn-1",
						payloadJson: request,
						requestedAt: 1,
					},
				});
				return yield* readSessionTimelineSnapshot(
					sql,
					SessionId.make("interactions"),
				);
			}),
		);

		expect(snapshot.projection.messages).toHaveLength(100);
		expect(snapshot.projection.interactions).toHaveLength(2);
		expect(snapshot.projection.interactions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ _tag: "Question", id: "question-old" }),
				expect.objectContaining({
					_tag: "Permission",
					id: "permission-old",
				}),
			]),
		);
	});

	test("lists sessions and pages messages by durable sequence", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO sessions
						(id, project_id, title, provider_id, model, status, archived_at,
						 runtime_mode, agents_json, worktree_id,
						 chat_id, forked_from_session_id, forked_from_message_id,
						 permission_mode, tool_search, created_at, updated_at)
					VALUES
						('session-1', 'project-1', 'Title', 'claude', 'model', 'idle',
						 NULL, 'approval-required', NULL, NULL, 'chat-1',
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
					transcript: yield* queries.transcript("session-1"),
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
		expect(result.transcript.session).toEqual(result.list[0]);
		expect(
			result.transcript.messages.map(({ messageId }) => messageId),
		).toEqual(["message-1", "message-2"]);
		expect(result.page).toMatchObject({
			items: [expect.objectContaining({ messageId: "message-2", sequence: 6 })],
			olderSequence: 6,
		});
	});

	test("chat reads share provider-thread decoding and preserve archive filtering and ordering", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				for (const [id, chatId, createdAt, updatedAt, archivedAt] of [
					["older", "chat-1", "2026-01-01", "2026-01-03", null],
					["newer", "chat-1", "2026-01-02", "2026-01-02", null],
					["archived", "chat-1", "2026-01-03", "2026-01-04", "2026-01-04"],
					["other", "chat-2", "2026-01-01", "2026-01-05", null],
				] as const) {
					yield* sql`INSERT INTO sessions
					(id, project_id, title, provider_id, model, status, runtime_mode, chat_id,
					permission_mode, tool_search, created_at, updated_at, archived_at)
					VALUES (${id}, 'project-1', 'Title', 'codex', 'model', 'idle', 'approval-required',
					${chatId}, 'default', 0, ${createdAt}, ${updatedAt}, ${archivedAt})`;
				}
				yield* sql`INSERT INTO session_provider_threads
				(id, session_id, provider, native_thread_id, native_head_id, status, created_at, updated_at)
				VALUES ('thread-1', 'older', 'codex', 'native-1', 'head-1', 'active', '2026-01-01', '2026-01-03')`;
				yield* sql`UPDATE sessions SET active_provider_thread_id = 'thread-1' WHERE id = 'older'`;
				const queries = makeSqlSessionQueries(sql);
				return {
					active: yield* queries.listByChat({ chatId: "chat-1" }),
					preview: yield* queries.listByChat({
						chatId: "chat-1",
						includeArchived: true,
						order: "created",
					}),
					single: yield* queries.get("older"),
					empty: yield* queries.listByChat({ chatId: "missing" }),
				};
			}),
		);
		expect(result.active.map(({ sessionId }) => sessionId)).toEqual([
			"older",
			"newer",
		]);
		expect(result.preview.map(({ sessionId }) => sessionId)).toEqual([
			"older",
			"newer",
			"archived",
		]);
		expect(result.active[0]).toEqual(result.single);
		expect(result.active[0]?.activeProviderThread).toMatchObject({
			id: "thread-1",
			nativeThreadId: "native-1",
			nativeHeadId: "head-1",
		});
		expect(result.empty).toEqual([]);
	});

	test("fails malformed persisted timestamps at the query boundary", async () => {
		const exit = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO sessions
						(id, project_id, title, provider_id, model, status,
						 runtime_mode, chat_id, permission_mode, tool_search, created_at, updated_at)
					VALUES
						('bad', 'project-1', 'Bad', 'claude', 'model', 'idle',
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
						(id, project_id, title, provider_id, model, status,
						 runtime_mode, chat_id, permission_mode, tool_search, created_at, updated_at)
					VALUES
						('large', 'project-1', 'Large', 'claude', 'model', 'idle',
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
						(id, project_id, title, provider_id, model, status,
						 runtime_mode, chat_id, permission_mode, tool_search, created_at, updated_at)
					VALUES
						('large-queue', 'project-1', 'Large queue', 'claude', 'model',
						 'running', 'approval-required', 'chat-1', 'default', 0,
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

test("history pages obey a byte budget and retain every message exactly once", async () => {
	await run(
		Effect.gen(function* () {
			yield* createDomainTestSchema();
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions (id,project_id,title,provider_id,model,status,runtime_mode,chat_id,permission_mode,tool_search,created_at,updated_at) VALUES ('budget','project','Budget','claude','model','idle','approval-required','chat','default',0,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
			for (let sequence = 1; sequence <= 6; sequence++) {
				const content = JSON.stringify({
					_tag: "assistant",
					text: "界".repeat(sequence === 3 ? 200_000 : 15_000),
				});
				yield* sql`INSERT INTO messages (id,session_id,role,kind,content_json,created_at,sequence) VALUES (${`budget-${sequence}`},'budget','assistant','assistant',${content},'2026-01-01T00:00:00.000Z',${sequence})`;
			}
			const queries = makeSqlSessionQueries(sql);
			const seen: string[] = [];
			let before: number | null | undefined;
			do {
				const page = yield* queries.messagePage({
					sessionId: "budget",
					beforeSequence: before,
					limit: 100,
				});
				const bytes = page.items.reduce(
					(sum, row) =>
						sum + new TextEncoder().encode(row.contentJson).byteLength,
					0,
				);
				expect(bytes <= 256 * 1024 || page.items.length === 1).toBe(true);
				seen.unshift(...page.items.map((row) => row.messageId));
				if (page.olderSequence !== null)
					expect(page.olderSequence).toBeLessThan(
						before ?? Number.MAX_SAFE_INTEGER,
					);
				before = page.olderSequence;
			} while (before !== null);
			expect(seen).toEqual(
				Array.from({ length: 6 }, (_, index) => `budget-${index + 1}`),
			);
		}),
	);
});

test("opt-in snapshots defer heavy display bodies while detail queries retain originals and session isolation", async () => {
	await run(
		Effect.gen(function* () {
			yield* createDomainTestSchema();
			const sql = yield* SqlClient.SqlClient;
			for (const id of ["details", "other"])
				yield* sql`INSERT INTO sessions (id,project_id,title,provider_id,model,status,runtime_mode,chat_id,permission_mode,tool_search,created_at,updated_at) VALUES (${id},'project','Details','claude','model','idle','approval-required','chat','default',0,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
			const contents = [
				{
					_tag: "tool_use",
					itemId: "shell",
					tool: "Bash",
					input: { command: "build" },
				},
				{
					_tag: "tool_result",
					itemId: "shell",
					output: "界".repeat(100_000),
					isError: true,
				},
				{
					_tag: "tool_use",
					itemId: "edit",
					tool: "Edit",
					input: {
						file_path: "file.ts",
						old_string: "old",
						new_string: "new".repeat(40_000),
					},
				},
				{ _tag: "tool_result", itemId: "edit", output: "done", isError: false },
			];
			for (const [index, content] of contents.entries())
				yield* sql`INSERT INTO messages (id,session_id,role,kind,content_json,created_at,sequence) VALUES (${`detail-${index}`},'details','assistant',${content._tag},${JSON.stringify(content)},'2026-01-01T00:00:00.000Z',${index + 1})`;
			const legacy = yield* readSessionTimelineSnapshot(
				sql,
				SessionId.make("details"),
			);
			const compact = yield* readSessionTimelineSnapshot(
				sql,
				SessionId.make("details"),
				true,
			);
			if (process.env.ZUSE_TRANSFER_REPORT === "1")
				console.log(
					JSON.stringify({
						legacyBytes: new TextEncoder().encode(
							JSON.stringify(legacy.projection),
						).byteLength,
						compactBytes: new TextEncoder().encode(
							JSON.stringify(compact.projection),
						).byteLength,
						messages: compact.projection.messages.length,
					}),
				);
			expect(legacy.projection.messages).toHaveLength(4);
			expect(compact.projection.messages).toHaveLength(4);
			expect(
				new TextEncoder().encode(JSON.stringify(legacy.projection)).byteLength,
			).toBeGreaterThan(400_000);
			expect(
				new TextEncoder().encode(JSON.stringify(compact.projection)).byteLength,
			).toBeLessThan(125_000);
			expect(compact.projection.messages[1]?.content).toMatchObject({
				isError: true,
				outputDeferred: expect.any(String),
			});
			expect(compact.projection.messages[2]?.content).toMatchObject({
				input: contents[2]?.input,
			});

			const raw = yield* readSessionMessageContent(sql, "details", "detail-1");
			expect(raw).not.toBeNull();
			expect(new TextDecoder().decode(raw?.content)).toBe(
				JSON.stringify(contents[1]),
			);
			expect(
				yield* readSessionMessageContent(sql, "other", "detail-1"),
			).toBeNull();
			const queries = makeSqlSessionQueries(sql);
			const full = yield* queries.messagePage({
				sessionId: "details",
				messageId: "detail-1",
				limit: 1,
			});
			expect(JSON.parse(full.items[0]?.contentJson ?? "null")).toEqual(
				contents[1],
			);
			const wrongSession = yield* queries.messagePage({
				sessionId: "other",
				messageId: "detail-1",
				limit: 1,
			});
			expect(wrongSession.items).toEqual([]);
			expect(legacy.projection.messages[2]?.content).toEqual(contents[2]);
		}),
	);
});
