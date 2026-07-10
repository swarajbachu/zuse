import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";

import { createDomainTestSchema } from "../test/sql-schema.js";
import { makeChatDomain } from "./chat-domain.js";

const run = <A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient>) =>
	Effect.runPromise(
		program.pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);

describe("ChatDomain", () => {
	test("dispatches and projects durable chat lifecycle commands", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				let eventId = 0;
				const domain = yield* makeChatDomain(yield* SqlClient.SqlClient, () =>
					Effect.succeed(`event-${++eventId}`),
				);
				yield* domain.dispatch({
					commandId: "create-chat",
					streamId: "chat-1",
					command: {
						_tag: "CreateChat",
						chatId: "chat-1",
						projectId: "project-1",
						worktreeId: null,
						title: "First",
						originSessionId: null,
						lastReadAt: 10,
						createdAt: 10,
					},
				});
				yield* domain.dispatch({
					commandId: "rename-chat",
					streamId: "chat-1",
					command: { _tag: "RenameChat", title: "Renamed", updatedAt: 20 },
				});
				const sql = yield* SqlClient.SqlClient;
				const chats = yield* sql<{
					readonly title: string;
					readonly last_read_at: string;
				}>`SELECT title, last_read_at FROM chats WHERE id = 'chat-1'`;
				const events = yield* sql<{ readonly stream_kind: string }>`
					SELECT stream_kind FROM events ORDER BY sequence
				`;
				return { chats, events };
			}),
		);

		expect(result.chats).toEqual([
			{ title: "Renamed", last_read_at: new Date(10).toISOString() },
		]);
		expect(result.events).toEqual([
			{ stream_kind: "chat" },
			{ stream_kind: "chat" },
		]);
	});

	test("replays an existing command receipt without duplicate events", async () => {
		const count = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				let eventId = 0;
				const domain = yield* makeChatDomain(yield* SqlClient.SqlClient, () =>
					Effect.succeed(`event-${++eventId}`),
				);
				const input = {
					commandId: "create-chat",
					streamId: "chat-1",
					command: {
						_tag: "CreateChat" as const,
						chatId: "chat-1",
						projectId: "project-1",
						worktreeId: null,
						title: "First",
						originSessionId: null,
						lastReadAt: null,
						createdAt: 10,
					},
				};
				yield* domain.dispatch(input);
				yield* domain.dispatch(input);
				const sql = yield* SqlClient.SqlClient;
				const rows = yield* sql<{ readonly count: number }>`
					SELECT COUNT(*) AS count FROM events WHERE stream_kind = 'chat'
				`;
				return rows[0]?.count;
			}),
		);

		expect(count).toBe(1);
	});
});
