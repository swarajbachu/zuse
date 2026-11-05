import {
	MessageId,
	SESSION_MESSAGE_DETAIL_CHUNK_BYTES,
	SessionId,
	SessionMessagesPageRpc,
} from "@zuse/contracts";
import { SqlSessionQueries } from "@zuse/domain/queries/sql-session-queries";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer } from "effect";
import { RpcGroup, RpcTest } from "effect/unstable/rpc";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { createDomainTestSchema } from "../../../../packages/domain/src/test/sql-schema.ts";
import { SessionMessagesPage } from "../../src/provider/handlers.ts";

test("serves opted-in details through the existing session-scoped RPC and preserves legacy reads", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				for (const id of ["session", "other"])
					yield* sql`INSERT INTO sessions (id,project_id,title,provider_id,model,status,runtime_mode,chat_id,permission_mode,tool_search,created_at,updated_at) VALUES (${id},'project','Details','claude','model','idle','approval-required','chat','default',0,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
				const content = {
					_tag: "tool_result",
					itemId: "tool",
					output: "界".repeat(100_000),
					isError: false,
				};
				yield* sql`INSERT INTO messages (id,session_id,role,kind,content_json,created_at,sequence) VALUES ('message','session','assistant','tool_result',${JSON.stringify(content)},'2026-01-01T00:00:00.000Z',1)`;
				yield* Effect.gen(function* () {
					const client = yield* RpcTest.makeClient(
						RpcGroup.make(SessionMessagesPageRpc),
						{ flatten: true },
					);
					const sessionId = SessionId.make("session");
					const messageId = MessageId.make("message");
					const head = yield* client("session.messages.page", {
						sessionId,
						messageId,
						detailOffset: 0,
					});
					expect(head.messages).toEqual([]);
					expect(head.detailChunk?.nextOffset).toBe(
						SESSION_MESSAGE_DETAIL_CHUNK_BYTES,
					);
					expect(
						Buffer.from(head.detailChunk?.contentBase64 ?? "", "base64").length,
					).toBe(SESSION_MESSAGE_DETAIL_CHUNK_BYTES);
					const other = yield* client("session.messages.page", {
						sessionId: SessionId.make("other"),
						messageId,
						detailOffset: 0,
					});
					expect(other.detailChunk).toBeNull();
					const legacy = yield* client("session.messages.page", {
						sessionId,
						messageId,
					});
					expect(legacy.detailChunk).toBeUndefined();
					expect(legacy.messages[0]?.content).toEqual(content);
				}).pipe(
					Effect.provide(
						SessionMessagesPage.pipe(
							Layer.provideMerge(SqlSessionQueries.layer),
						),
					),
				);
			}),
		).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
	);
});
