import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Exit } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";

import type { SessionCommand } from "../core/commands.js";
import { DispatchEngine } from "./dispatch.js";
import { ProjectorRunner } from "./projector-runner.js";
import { ReactorRunner } from "./reactor-runner.js";
import { makeSqlConsumerStorage } from "./sql-consumer-storage.js";
import { makeSqlDispatchStorage } from "./sql-dispatch-storage.js";

const createSchema = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`
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
			correlation_id TEXT,
			causation_event_id TEXT,
			UNIQUE (stream_kind, stream_id, stream_version)
		)
	`;
	yield* sql`
		CREATE TABLE projector_cursors (
			projector_name TEXT PRIMARY KEY,
			last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
			updated_at TEXT NOT NULL
		)
	`;
	yield* sql`
		CREATE TABLE command_receipts (
			command_id TEXT PRIMARY KEY,
			stream_kind TEXT NOT NULL,
			stream_id TEXT NOT NULL,
			stream_version INTEGER NOT NULL,
			event_ids_json TEXT NOT NULL,
			result_json TEXT,
			created_at TEXT NOT NULL
		)
	`;
	yield* sql`
		CREATE TABLE projected_messages (
			message_id TEXT PRIMARY KEY,
			content_json TEXT NOT NULL
		)
	`;
});

const run = <A, E>(
	program: Effect.Effect<A, E, SqlClient.SqlClient>,
): Promise<A> =>
	Effect.runPromise(
		program.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
	);

const insertEvent = (
	eventId: string,
	streamId: string,
	streamVersion: number,
	payload: unknown,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`
			INSERT INTO events
				(event_id, correlation_id, causation_event_id, stream_kind,
				 stream_id, stream_version, type, occurred_at, actor, payload_json)
			VALUES
				(${eventId}, ${eventId}, NULL, 'session', ${streamId}, ${streamVersion},
				 ${typeof payload === "object" && payload !== null && "_tag" in payload ? String(payload._tag) : "BadEvent"},
				 '2026-01-01T00:00:00.000Z', NULL, ${JSON.stringify(payload)})
		`;
	});

describe("SqlConsumerStorage", () => {
	test("loads events after the durable cursor in global sequence order", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createSchema;
				const sql = yield* SqlClient.SqlClient;
				yield* insertEvent("event-1", "session-1", 1, {
					_tag: "SessionCreated",
					sessionId: "session-1",
					chatId: "chat-1",
					projectId: "project-1",
					createdAt: 1,
				});
				yield* insertEvent("event-2", "session-2", 1, {
					_tag: "SessionCreated",
					sessionId: "session-2",
					chatId: "chat-2",
					projectId: "project-1",
					createdAt: 2,
				});
				yield* sql`
					INSERT INTO projector_cursors
						(projector_name, last_sequence, updated_at)
					VALUES ('sessions', 1, '2026-01-01T00:00:00.000Z')
				`;

				const storage = makeSqlConsumerStorage(sql);
				const cursor = yield* storage.cursor("sessions");
				const events = yield* storage.eventsAfter(cursor);
				return { cursor, events };
			}),
		);

		expect(result.cursor).toBe(1);
		expect(result.events.map((event) => event.eventId)).toEqual(["event-2"]);
		expect(result.events.map((event) => event.sequence)).toEqual([2]);
	});

	test("commits projector writes and cursor atomically", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createSchema;
				const sql = yield* SqlClient.SqlClient;
				yield* insertEvent("event-1", "session-1", 1, {
					_tag: "MessagePersisted",
					messageId: "message-1",
					turnId: null,
					role: "user",
					kind: "text",
					contentJson: '{"text":"hello"}',
					parentItemId: null,
					createdAt: 1,
				});

				const storage = makeSqlConsumerStorage(sql);
				const runner = new ProjectorRunner(storage, {
					name: "messages",
					sequenceOf: (event) => event.sequence,
					apply: (record) =>
						Effect.gen(function* () {
							if (record.event._tag !== "MessagePersisted") return;
							yield* sql`
								INSERT INTO projected_messages
									(message_id, content_json)
								VALUES
									(${record.event.messageId}, ${record.event.contentJson})
							`;
						}),
				});
				const cursor = yield* runner.catchUp();
				const rows = yield* sql<{
					readonly message_id: string;
					readonly content_json: string;
				}>`
					SELECT message_id, content_json
					FROM projected_messages
				`;
				return {
					cursor,
					rows,
					storedCursor: yield* storage.cursor("messages"),
				};
			}),
		);

		expect(result.cursor).toBe(1);
		expect(result.storedCursor).toBe(1);
		expect(result.rows).toEqual([
			{ message_id: "message-1", content_json: '{"text":"hello"}' },
		]);
	});

	test("never moves a durable cursor backwards", async () => {
		const cursor = await run(
			Effect.gen(function* () {
				yield* createSchema;
				const sql = yield* SqlClient.SqlClient;
				const storage = makeSqlConsumerStorage(sql);
				yield* storage.commitCursor("messages", 8);
				yield* storage.commitCursor("messages", 3);
				return yield* storage.cursor("messages");
			}),
		);

		expect(cursor).toBe(8);
	});

	test("rolls back projector writes when cursor commit fails", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createSchema;
				const sql = yield* SqlClient.SqlClient;
				const storage = makeSqlConsumerStorage(sql);
				const exit = yield* Effect.exit(
					storage.applyAndCommit(
						"messages",
						-1,
						sql`
							INSERT INTO projected_messages
								(message_id, content_json)
							VALUES
								('message-1', '{}')
						`.pipe(Effect.asVoid),
					),
				);
				const rows = yield* sql`SELECT * FROM projected_messages`;
				const cursor = yield* storage.cursor("messages");
				return { exit, rows, cursor };
			}),
		);

		expect(Exit.isFailure(result.exit)).toBe(true);
		expect(result.rows).toEqual([]);
		expect(result.cursor).toBe(0);
	});

	test("rolls back cursor advancement when projector apply fails", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createSchema;
				const sql = yield* SqlClient.SqlClient;
				const storage = makeSqlConsumerStorage(sql);
				const exit = yield* Effect.exit(
					storage.applyAndCommit(
						"messages",
						1,
						Effect.gen(function* () {
							yield* sql`
								INSERT INTO projected_messages
									(message_id, content_json)
								VALUES
									('message-1', '{}')
							`;
							yield* sql`
								INSERT INTO projected_messages
									(message_id, content_json)
								VALUES
									('message-1', '{}')
							`;
						}),
					),
				);
				const rows = yield* sql`SELECT * FROM projected_messages`;
				const cursor = yield* storage.cursor("messages");
				return { exit, rows, cursor };
			}),
		);

		expect(Exit.isFailure(result.exit)).toBe(true);
		expect(result.rows).toEqual([]);
		expect(result.cursor).toBe(0);
	});

	test("replays a reactor dispatch with the same receipt after cursor commit fails", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createSchema;
				const sql = yield* SqlClient.SqlClient;
				yield* insertEvent("event-1", "session-1", 1, {
					_tag: "SessionCreated",
					sessionId: "session-1",
					chatId: "chat-1",
					projectId: "project-1",
					createdAt: 1,
				});

				const consumerStorage = makeSqlConsumerStorage(sql);
				const dispatchStorage = makeSqlDispatchStorage(sql);
				const engine = new DispatchEngine(
					dispatchStorage,
					() => "event-from-reactor",
				);
				const dispatchedCommandIds: string[] = [];
				const dispatch = (input: {
					readonly streamId: string;
					readonly commandId: string;
					readonly correlationId: string;
					readonly causationEventId: string;
					readonly command: SessionCommand;
				}) => {
					dispatchedCommandIds.push(input.commandId);
					return engine
						.dispatch(input)
						.pipe(Effect.mapError((error): unknown => error));
				};
				const reactor = {
					name: "auto-title",
					react: (record: { readonly event: { readonly _tag: string } }) =>
						record.event._tag === "SessionCreated"
							? Effect.succeed([
									{
										streamId: "session-1",
										command: {
											_tag: "SetTitle",
											title: "Generated title",
										} satisfies SessionCommand,
									},
								])
							: Effect.succeed([]),
				};
				const failingCursorStorage = {
					cursor: (consumerName: string) =>
						consumerStorage
							.cursor(consumerName)
							.pipe(Effect.mapError((error): unknown => error)),
					eventsAfter: (sequence: number) =>
						consumerStorage
							.eventsAfter(sequence)
							.pipe(Effect.mapError((error): unknown => error)),
					commitCursor: () => Effect.fail(new Error("cursor failed")),
				};
				const replayCursorStorage = {
					cursor: (consumerName: string) =>
						consumerStorage
							.cursor(consumerName)
							.pipe(Effect.mapError((error): unknown => error)),
					eventsAfter: (sequence: number) =>
						consumerStorage
							.eventsAfter(sequence)
							.pipe(Effect.mapError((error): unknown => error)),
					commitCursor: (consumerName: string, sequence: number) =>
						consumerStorage
							.commitCursor(consumerName, sequence)
							.pipe(Effect.mapError((error): unknown => error)),
				};

				const firstExit = yield* Effect.exit(
					new ReactorRunner(failingCursorStorage, dispatch, reactor).catchUp(),
				);
				const cursorAfterFailure =
					yield* consumerStorage.cursor("reactor:auto-title");

				const replayCursor = yield* new ReactorRunner(
					replayCursorStorage,
					dispatch,
					reactor,
				).catchUp();
				const events = yield* dispatchStorage.events("session-1");
				const receipt = yield* dispatchStorage.receipt(
					"reactor:auto-title:event-1:0",
				);

				return {
					firstExit,
					cursorAfterFailure,
					replayCursor,
					events,
					receipt,
					dispatchedCommandIds,
				};
			}),
		);

		expect(Exit.isFailure(result.firstExit)).toBe(true);
		expect(result.cursorAfterFailure).toBe(0);
		expect(result.replayCursor).toBe(2);
		expect(result.events.map((event) => event.event._tag)).toEqual([
			"SessionCreated",
			"SessionTitleSet",
		]);
		expect(result.receipt).toMatchObject({
			commandId: "reactor:auto-title:event-1:0",
			eventIds: ["event-from-reactor"],
		});
		expect(result.dispatchedCommandIds).toEqual([
			"reactor:auto-title:event-1:0",
			"reactor:auto-title:event-1:0",
		]);
	});

	test("fails at the schema boundary for malformed persisted events", async () => {
		const failure = await run(
			Effect.gen(function* () {
				yield* createSchema;
				const sql = yield* SqlClient.SqlClient;
				yield* insertEvent("bad-event", "session-1", 1, {});
				return yield* makeSqlConsumerStorage(sql)
					.eventsAfter(0)
					.pipe(Effect.flip);
			}),
		);

		expect(failure).toMatchObject({
			_tag: "DispatchPersistenceDecodeError",
			recordId: "bad-event",
		});
	});
});
