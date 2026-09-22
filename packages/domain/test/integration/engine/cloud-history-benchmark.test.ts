import { writeFileSync } from "node:fs";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { makeSessionDomain } from "../../../src/engine/session-domain";
import { createSessionCommand } from "../../../src/test/session";
import { createDomainTestSchema } from "../../../src/test/sql-schema";

test("recent cloud synchronization remains bounded as history grows", async () => {
	const results = await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* createDomainTestSchema();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO chats (id, updated_at) VALUES ('chat-1', '1970-01-01T00:00:00.000Z')`;
				const domain = yield* makeSessionDomain(sql, () =>
					Effect.succeed("benchmark-event"),
				);
				yield* domain.dispatch({
					commandId: "create-benchmark",
					streamId: "session-1",
					command: createSessionCommand,
				});
				const results = [];
				for (const count of [10, 1000, 10000]) {
					yield* sql`DELETE FROM messages`;
					const content = JSON.stringify({
						_tag: "assistant",
						text: "large command output\n".repeat(100),
					});
					yield* sql`WITH RECURSIVE series(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM series WHERE n<${count}) INSERT INTO messages (id,session_id,role,kind,content_json,parent_item_id,created_at,sequence) SELECT 'message-' || n, 'session-1', 'assistant', 'assistant', ${content}, NULL, '2026-01-01T00:00:00.000Z', n FROM series`;
					for (const background of [false, true]) {
						const start = performance.now();
						const frames = yield* domain
							.synchronizedEvents({
								streamId: "session-1",
								hasProjection: false,
								...(background ? { historyMode: "background" as const } : {}),
							})
							.pipe(
								Stream.takeUntil((frame) => frame.kind === "synchronized"),
								Stream.runCollect,
							);
						const ms = performance.now() - start;
						const delivered = frames.flatMap((frame) =>
							frame.kind === "snapshot"
								? frame.projection.messages
								: frame.kind === "snapshot-chunk"
									? frame.messages
									: [],
						);
						expect(delivered.length).toBe(
							background ? Math.min(100, count) : count,
						);
						if (background) expect(frames.length).toBe(2);
						results.push({
							count,
							background,
							ms,
							initialBytes: JSON.stringify(frames).length,
						});
					}
				}
				return results;
			}).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" }))),
		),
	);
	if (process.env.ZUSE_BENCHMARK_OUTPUT)
		writeFileSync(
			process.env.ZUSE_BENCHMARK_OUTPUT,
			JSON.stringify(results, null, 2),
		);
}, 30_000);
