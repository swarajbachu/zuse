import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Exit } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";

import { createSessionCommand } from "../test/session.js";
import { createDomainTestSchema } from "../test/sql-schema.js";
import { DispatchEngine } from "./dispatch.js";
import { makeSqlDispatchStorage } from "./sql-dispatch-storage.js";

const run = <A, E>(
	program: Effect.Effect<A, E, SqlClient.SqlClient>,
): Promise<A> =>
	Effect.runPromise(
		program.pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);

describe("SqlDispatchStorage", () => {
	test("persists receipts so a new engine replays without appending", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				const storage = makeSqlDispatchStorage(sql);
				const firstEngine = new DispatchEngine(storage, () =>
					Effect.succeed("event-1"),
				);
				const first = yield* firstEngine.dispatch({
					commandId: "command-1",
					streamId: "session-1",
					command: createSessionCommand,
				});
				const restartedEngine = new DispatchEngine(storage, () =>
					Effect.succeed("unexpected"),
				);
				const replay = yield* restartedEngine.dispatch({
					commandId: "command-1",
					streamId: "session-1",
					command: createSessionCommand,
				});
				const events = yield* storage.events("session-1");
				const afterZero = yield* storage.eventsAfterSequence("session-1", 0);
				const afterOne = yield* storage.eventsAfterSequence("session-1", 1);
				const receiptEvents = yield* storage.eventsInVersionRange(
					"session-1",
					0,
					1,
				);
				return { first, replay, events, afterZero, afterOne, receiptEvents };
			}),
		);

		expect(result.replay).toEqual(result.first);
		expect(result.first.eventIds).toEqual(["event-1"]);
		expect(result.events).toHaveLength(1);
		expect(result.afterZero.map((event) => event.eventId)).toEqual(["event-1"]);
		expect(result.afterOne).toEqual([]);
		expect(result.receiptEvents.map((event) => event.eventId)).toEqual([
			"event-1",
		]);
	});

	test("rolls back events when receipt persistence cannot commit", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				const storage = makeSqlDispatchStorage(sql);
				const appended = yield* Effect.exit(
					storage.append({
						commandId: "command-1",
						streamId: "session-1",
						correlationId: "command-1",
						causationEventId: null,
						expectedVersion: 0,
						events: [
							{
								eventId: "duplicate-event",
								event: {
									_tag: "SessionCreated",
									sessionId: "session-1",
									chatId: "chat-1",
									projectId: "project-1",
									createdAt: 1,
								},
							},
							{
								eventId: "duplicate-event",
								event: {
									_tag: "SessionTitleSet",
									title: "Title",
									updatedAt: 2,
								},
							},
						],
					}),
				);
				const events = yield* storage.events("session-1");
				const receipt = yield* storage.receipt("command-1");
				return { appended, events, receipt };
			}),
		);

		expect(Exit.isFailure(result.appended)).toBe(true);
		expect(result.events).toEqual([]);
		expect(result.receipt).toBeNull();
	});

	test("fails at the schema boundary for malformed persisted events", async () => {
		const failure = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO events
						(event_id, correlation_id, causation_event_id, stream_kind,
						 stream_id, stream_version, type, occurred_at, actor, payload_json)
					VALUES
						('bad-event', 'bad-event', NULL, 'session', 'session-1', 1,
						 'SessionCreated', '2026-01-01T00:00:00.000Z', NULL, '{}')
				`;
				return yield* makeSqlDispatchStorage(sql)
					.events("session-1")
					.pipe(Effect.flip);
			}),
		);

		expect(failure).toMatchObject({
			_tag: "DispatchPersistenceDecodeError",
			recordId: "bad-event",
		});
	});
});
