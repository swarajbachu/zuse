import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";

import type { StoredEvent } from "../engine/dispatch.js";
import { sessionCreation } from "../test/session.js";
import { createDomainTestSchema } from "../test/sql-schema.js";
import { makeSqlSessionProjector } from "./sql-session-projector.js";

const run = <A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient>) =>
	Effect.runPromise(
		program.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
	);

const stored = (
	sequence: number,
	event: StoredEvent["event"],
): StoredEvent => ({
	eventId: `event-${sequence}`,
	correlationId: "command-1",
	causationEventId: null,
	streamId: "session-1",
	streamVersion: sequence,
	sequence,
	event,
});

describe("SqlSessionProjector", () => {
	test("rebuilds a complete session and byte-identical message row", async () => {
		const result = await run(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO chats (id, updated_at)
					VALUES ('chat-1', '1970-01-01T00:00:00.000Z')
				`;
				const projector = makeSqlSessionProjector(sql);
				yield* projector.apply(
					stored(1, { _tag: "SessionCreated", ...sessionCreation }),
				);
				yield* projector.apply(
					stored(2, {
						_tag: "MessagePersisted",
						messageId: "message-1",
						turnId: null,
						role: "user",
						kind: "text",
						contentJson: '{"spacing":  "preserved"}',
						parentItemId: null,
						createdAt: 20,
					}),
				);
				const sessions = yield* sql<{
					readonly id: string;
					readonly provider_id: string;
					readonly model: string;
					readonly runtime_mode: string;
				}>`SELECT id, provider_id, model, runtime_mode FROM sessions`;
				const messages = yield* sql<{
					readonly content_json: string;
					readonly sequence: number;
				}>`SELECT content_json, sequence FROM messages`;
				const chats = yield* sql<{
					readonly active_session_id: string | null;
					readonly last_message_at: string | null;
				}>`SELECT active_session_id, last_message_at FROM chats`;
				return { sessions, messages, chats };
			}),
		);

		expect(result.sessions).toEqual([
			{
				id: "session-1",
				provider_id: "provider-1",
				model: "model-1",
				runtime_mode: "approval-required",
			},
		]);
		expect(result.messages).toEqual([
			{ content_json: '{"spacing":  "preserved"}', sequence: 2 },
		]);
		expect(result.chats).toEqual([
			{
				active_session_id: "session-1",
				last_message_at: new Date(20).toISOString(),
			},
		]);
	});

	test("rejects an incomplete legacy creation event", async () => {
		await expect(
			run(
				Effect.gen(function* () {
					yield* createDomainTestSchema();
					const sql = yield* SqlClient.SqlClient;
					yield* makeSqlSessionProjector(sql).apply(
						stored(1, {
							_tag: "SessionCreated",
							sessionId: "session-1",
							chatId: "chat-1",
							projectId: "project-1",
							createdAt: 1,
						}),
					);
				}),
			),
		).rejects.toMatchObject({ _tag: "SessionProjectionDecodeError" });
	});
});
