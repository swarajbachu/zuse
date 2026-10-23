import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import {
	BLOCKED_SESSIONS_SQL,
	BUSY_SESSIONS_SQL,
} from "../../src/master/service.ts";
import { MigrationsLive } from "../../src/persistence/migrations.ts";

// Zot snapshots run these for every repository every couple of seconds on the
// synchronous engine connection. A table scan per correlated lookup took ~5 s
// on a real 150k-event history and stalled every other RPC, so every step must
// be an index seek scoped to the repository's sessions.
describe("Zot catalog queries", () => {
	it("seek only the repository's turn and permission events", async () => {
		const runtime = ManagedRuntime.make(
			MigrationsLive.pipe(
				Layer.provideMerge(sqliteLayer({ filename: ":memory:" })),
			),
		);
		try {
			const plans = await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const plan = (query: string) =>
						sql
							.unsafe<{ readonly detail: string }>(
								`EXPLAIN QUERY PLAN ${query}`,
								['["session"]'],
							)
							.pipe(
								Effect.map((rows) => rows.map((row) => row.detail).join("\n")),
							);
					return {
						busy: yield* plan(BUSY_SESSIONS_SQL),
						blocked: yield* plan(BLOCKED_SESSIONS_SQL),
					};
				}),
			);
			for (const plan of [plans.busy, plans.blocked]) {
				// The only scan is over the bound list of session ids.
				expect(plan.replaceAll("SCAN json_each", "")).not.toMatch(/\bSCAN\b/);
				expect(plan).toMatch(
					/SEARCH e USING (COVERING )?INDEX idx_events_kind_type_stream \(stream_kind=\? AND type=\? AND stream_id=\?\)/,
				);
				expect(plan).toMatch(
					/SEARCH (later|resolved) USING (COVERING )?INDEX idx_events_kind_type_stream \(stream_kind=\? AND type=\? AND stream_id=\? AND sequence>\?\)/,
				);
			}
		} finally {
			await runtime.dispose();
		}
	});

	it("report running turns and unanswered permissions for the given sessions only", async () => {
		const runtime = ManagedRuntime.make(
			MigrationsLive.pipe(
				Layer.provideMerge(sqliteLayer({ filename: ":memory:" })),
			),
		);
		try {
			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const now = new Date().toISOString();
					yield* sql`INSERT INTO projects (id,path,name,created_at,updated_at) VALUES ('folder','/tmp/a','A',${now},${now}), ('other','/tmp/b','B',${now},${now})`;
					yield* sql`INSERT INTO chats (id,project_id,title,created_at,updated_at) VALUES ('chat','folder','A',${now},${now}), ('other-chat','other','B',${now},${now})`;
					const sessions = {
						running: "folder",
						settled: "folder",
						waiting: "folder",
						answered: "folder",
						elsewhere: "other",
					};
					for (const [id, project] of Object.entries(sessions))
						yield* sql`INSERT INTO sessions (id,project_id,chat_id,title,provider_id,model,status,created_at,updated_at) VALUES (${id},${project},${project === "folder" ? "chat" : "other-chat"},${id},'test','test','idle',${now},${now})`;
					let version = 0;
					const event = (stream: string, type: string, payload = {}) =>
						sql`INSERT INTO events (event_id,stream_kind,stream_id,stream_version,type,payload_json,occurred_at) VALUES (${`event-${++version}`},'session',${stream},${version},${type},${JSON.stringify(payload)},${now})`;
					yield* event("running", "TurnSettled");
					yield* event("running", "TurnStarted");
					yield* event("settled", "TurnStarted");
					yield* event("settled", "MessageAppended");
					yield* event("settled", "TurnSettled");
					yield* event("waiting", "PermissionRequested", { requestId: "a" });
					yield* event("waiting", "PermissionRequested", { requestId: "b" });
					yield* event("waiting", "PermissionResolved", { requestId: "a" });
					yield* event("answered", "PermissionRequested", { requestId: "c" });
					yield* event("answered", "PermissionResolved", { requestId: "c" });
					yield* event("elsewhere", "TurnStarted");
					yield* event("elsewhere", "PermissionRequested", { requestId: "d" });
					const ids = (query: string) =>
						sql
							.unsafe<{ readonly stream_id: string }>(query, [
								JSON.stringify(["running", "settled", "waiting", "answered"]),
							])
							.pipe(Effect.map((rows) => rows.map((row) => row.stream_id)));
					return {
						busy: yield* ids(BUSY_SESSIONS_SQL),
						blocked: yield* ids(BLOCKED_SESSIONS_SQL),
					};
				}),
			);
			expect(result).toEqual({ busy: ["running"], blocked: ["waiting"] });
		} finally {
			await runtime.dispose();
		}
	});
});
