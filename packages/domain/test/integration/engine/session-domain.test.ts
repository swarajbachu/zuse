import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Fiber, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";
import { makeSessionDomain } from "../../../src/engine/session-domain.js";
import { createSessionCommand } from "../../../src/test/session.js";
import { createDomainTestSchema } from "../../../src/test/sql-schema.js";

const run = <A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient>) =>
	Effect.runPromise(
		program.pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);

describe("SessionDomain", () => {
	test("dispatches, projects, and replays a durable receipt", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				let nextEventId = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`event-${++nextEventId}`),
				);
				const first = yield* domain.dispatch({
					commandId: "command-create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				const restarted = yield* makeSessionDomain(sql, () =>
					Effect.succeed("unexpected-event"),
				);
				const replay = yield* restarted.dispatch({
					commandId: "command-create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				const sessions = yield* sql<{ readonly id: string }>`
					SELECT id FROM sessions
				`;
				const events = yield* sql<{ readonly event_id: string }>`
					SELECT event_id FROM events
				`;
				const cursor = yield* sql<{ readonly last_sequence: number }>`
					SELECT last_sequence FROM projector_cursors
					WHERE projector_name = 'session-read-model'
				`;
				return { first, replay, sessions, events, cursor };
			}),
		);

		expect(result.replay).toEqual(result.first);
		expect(result.sessions).toEqual([{ id: "session-1" }]);
		expect(result.events).toEqual([{ event_id: "event-1" }]);
		expect(result.cursor).toEqual([{ last_sequence: 1 }]);
	});

	test("replays then tails one ordered stream without duplicate receipts", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				let nextEventId = 0;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed(`event-${++nextEventId}`),
				);
				yield* domain.dispatch({
					commandId: "command-create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				const replay = yield* domain
					.events({ streamId: "session-1" })
					.pipe(Stream.take(1), Stream.runCollect);
				const liveFiber = yield* domain
					.events({ streamId: "session-1", afterSequence: 1 })
					.pipe(
						Stream.take(1),
						Stream.runCollect,
						Effect.forkChild({ startImmediately: true }),
					);
				yield* domain.dispatch({
					commandId: "command-create",
					streamId: "session-1",
					command: createSessionCommand,
				});
				yield* domain.dispatch({
					commandId: "command-title",
					streamId: "session-1",
					command: { _tag: "SetTitle", title: "Renamed", updatedAt: 2 },
				});
				const live = yield* Fiber.join(liveFiber);
				return { replay: [...replay], live: [...live] };
			}),
		);

		expect(result.replay.map(({ sequence }) => sequence)).toEqual([1]);
		expect(result.live.map(({ sequence }) => sequence)).toEqual([2]);
		expect(result.live[0]?.event._tag).toBe("SessionTitleSet");
	});
});
