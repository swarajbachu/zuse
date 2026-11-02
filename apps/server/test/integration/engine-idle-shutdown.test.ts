import { JobId } from "@zuse/contracts";
import { makeSessionDomain } from "@zuse/domain/engine/session-domain";
import { makeSqlSessionQueries } from "@zuse/domain/queries/sql-session-queries";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, type Scope } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { createSessionCommand } from "../../../../packages/domain/src/test/session.ts";
import { createDomainTestSchema } from "../../../../packages/domain/src/test/sql-schema.ts";
import { reconcileSessionRuntime } from "../../src/conversation/core/startup-recovery.ts";
import { prepareIdleShutdown } from "../../src/desktop-engine/idle.ts";

const fixture = Effect.gen(function* () {
	yield* createDomainTestSchema();
	const sql = yield* SqlClient.SqlClient;
	let next = 0;
	const domain = yield* makeSessionDomain(sql, () =>
		Effect.succeed(`idle-${++next}`),
	);
	const queries = makeSqlSessionQueries(sql);
	yield* domain.dispatch({
		commandId: "create",
		streamId: "session-1",
		command: createSessionCommand,
	});
	let attached: string | undefined;
	const prepare = prepareIdleShutdown({
		sql,
		domain,
		activeTurnCount: queries.activeTurnCount,
		hasSession: (_, expected) => Effect.sync(() => expected === attached),
	});
	return {
		sql,
		domain,
		prepare,
		attach: (id: string) => {
			attached = id;
		},
	};
});
const run = <A, E>(
	effect: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
) =>
	Effect.runPromise(
		Effect.scoped(effect).pipe(
			Effect.provide(sqliteLayer({ filename: ":memory:" })),
		),
	);

it("refuses active turns and pending jobs without closing command admission", async () => {
	await run(
		Effect.gen(function* () {
			const f = yield* fixture;
			yield* f.domain.dispatch({
				commandId: "start",
				streamId: "session-1",
				command: { _tag: "StartTurn", turnId: "turn", startedAt: 1 },
			});
			expect(yield* f.prepare).toBe(false);
			yield* f.domain.dispatch({
				commandId: "settle",
				streamId: "session-1",
				command: {
					_tag: "SettleTurn",
					turnId: "turn",
					outcome: "completed",
					settledAt: 2,
				},
			});
			yield* f.domain.jobs.enqueue([
				{
					id: JobId.make("pending"),
					sessionId: "session-1",
					request: {
						_tag: "provider.stop",
						providerSessionId: "residency",
						requestedAt: 3,
					},
					causationEventId: "event",
					correlationId: "correlation",
				},
			]);
			expect(yield* f.prepare).toBe(false);
			expect(yield* f.domain.admission.run(Effect.succeed("open"))).toBe(
				"open",
			);
		}),
	);
});

it("waits for the exact pending provider residency while allowing idle warm providers", async () => {
	await run(
		Effect.gen(function* () {
			const f = yield* fixture;
			yield* f.domain.dispatch({
				commandId: "reserve",
				streamId: "session-1",
				command: {
					_tag: "ReserveProviderSession",
					providerId: "provider-1",
					providerSessionId: "new",
					reservedAt: 1,
				},
			});
			f.attach("old");
			expect(yield* f.prepare).toBe(false);
			f.attach("new");
			expect(yield* f.prepare).toBe(true);
			expect(
				yield* f.domain
					.dispatch({
						commandId: "later",
						streamId: "session-1",
						command: { _tag: "StartTurn", turnId: "later", startedAt: 2 },
					})
					.pipe(Effect.result),
			).toMatchObject({
				_tag: "Failure",
				failure: { _tag: "AdmissionClosed" },
			});
		}),
	);
});

it("treats an unfinished durable fork as work even before its destination is created", async () => {
	await run(
		Effect.gen(function* () {
			const f = yield* fixture;
			yield* f.sql`INSERT INTO session_fork_constructions (session_id, payload_json, created_at) VALUES ('destination', '{}', 1)`;
			expect(yield* f.prepare).toBe(false);
			yield* f.sql`UPDATE session_fork_constructions SET completed_at = 2`;
			expect(yield* f.prepare).toBe(true);
		}),
	);
});

it("waits for a durable file restore even when no provider turn is active", async () => {
	await run(
		Effect.gen(function* () {
			const f = yield* fixture;
			yield* f.sql`INSERT INTO session_checkpoint_restores(id,session_id,project_id,cwd,target_id,expected_id,status,created_at) VALUES ('restore','session-1','project','/checkout','target','expected','files_restored',1)`;
			expect(yield* f.prepare).toBe(false);
			yield* f.sql`UPDATE session_checkpoint_restores SET completed_at=2,status='completed' WHERE id='restore'`;
			expect(yield* f.prepare).toBe(true);
		}),
	);
});

it.each([
	"consumed",
	"cancelled",
] as const)("waits for a delegated result until it is %s", async (resolution) => {
	await run(
		Effect.gen(function* () {
			const f = yield* fixture;
			yield* f.sql`INSERT INTO session_delegations
					(child_session_id, child_turn_id, parent_session_id, parent_turn_id, parent_attempt_id, provider_session_id, result_message_id, created_at)
					VALUES ('child', 'child-turn', 'session-1', 'parent-turn', 'attempt', 'residency', 'result', 1)`;
			expect(yield* f.prepare).toBe(false);
			expect(yield* f.domain.admission.run(Effect.succeed("open"))).toBe(
				"open",
			);
			if (resolution === "consumed")
				yield* f.sql`UPDATE session_delegations SET wake_turn_id = 'consumer'`;
			else yield* f.sql`UPDATE session_delegations SET cancelled_at = 2`;
			expect(yield* f.prepare).toBe(true);
		}),
	);
});

const archiveDuringFinalization = (f: Effect.Success<typeof fixture>) =>
	Effect.gen(function* () {
		const dispatch = (
			commandId: string,
			command: Parameters<typeof f.domain.dispatch>[0]["command"],
		) => f.domain.dispatch({ commandId, streamId: "session-1", command });
		yield* dispatch("start", {
			_tag: "StartTurn",
			turnId: "turn",
			startedAt: 1,
		});
		yield* dispatch("interrupt", {
			_tag: "RequestTurnInterrupt",
			expectedTurnId: "turn",
			requestedAt: 2,
		});
		yield* dispatch("acknowledge", {
			_tag: "AcknowledgeTurnInterrupt",
			turnId: "turn",
			acknowledgedAt: 3,
		});
		yield* dispatch("finalize", {
			_tag: "FinalizeTurn",
			turnId: "turn",
			outcome: "interrupted",
			settledAt: 4,
		});
		yield* f.sql`UPDATE jobs SET status = 'succeeded', completed_at = 'now'`;
		expect(yield* f.prepare).toBe(false);
		yield* dispatch("archive", { _tag: "ArchiveSession", archivedAt: 5 });
	});

it("does not let a turn archived during finalization keep the engine busy", async () => {
	await run(
		Effect.gen(function* () {
			const f = yield* fixture;
			yield* archiveDuringFinalization(f);
			expect(yield* f.prepare).toBe(true);
		}),
	);
});

it("settles a turn archived during finalization on engine startup", async () => {
	await run(
		Effect.gen(function* () {
			const f = yield* fixture;
			yield* archiveDuringFinalization(f);
			yield* reconcileSessionRuntime(f.sql, f.domain);
			expect(
				yield* f.sql<{
					status: string;
				}>`SELECT status FROM session_turns WHERE id = 'turn'`,
			).toEqual([{ status: "interrupted" }]);
		}),
	);
});
