import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";

import { createSessionCommand } from "../test/session.js";
import { createDomainTestSchema } from "../test/sql-schema.js";
import { makeSessionDomain } from "./session-domain.js";

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
});
