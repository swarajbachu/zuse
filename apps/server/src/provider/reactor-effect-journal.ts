import { DateTime, Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";

export type ReactorEffectState =
	| "missing"
	| "started"
	| "completed"
	| "outcome-unknown";

export type ReactorEffectBegin =
	| "started"
	| "already-started"
	| "completed"
	| "outcome-unknown";

const terminal = (state: ReactorEffectState): boolean =>
	state === "completed" || state === "outcome-unknown";

/** Durable fence for replay-safe and explicitly non-replayable reactor work. */
export const makeReactorEffectJournal = (sql: SqlClient.SqlClient) => {
	const state = Effect.fn("ReactorEffectJournal.state")(function* (
		effectId: string,
	) {
		const rows = yield* sql<{
			readonly state: Exclude<ReactorEffectState, "missing">;
		}>`
			SELECT state FROM reactor_effect_receipts
			WHERE effect_id = ${effectId}
			LIMIT 1
		`.pipe(Effect.orDie);
		return rows[0]?.state ?? "missing";
	});

	return {
		state,

		isCompleted: Effect.fn("ReactorEffectJournal.isCompleted")(function* (
			effectId: string,
		) {
			return terminal(yield* state(effectId));
		}),

		/**
		 * Atomically crosses the no-automatic-replay boundary. `already-started`
		 * means a previous process may have delivered the external effect.
		 */
		begin: Effect.fn("ReactorEffectJournal.begin")(function* (
			effectId: string,
		): Effect.fn.Return<ReactorEffectBegin> {
			const startedAt = (yield* DateTime.nowAsDate).toISOString();
			const inserted = yield* sql<{ readonly effect_id: string }>`
				INSERT INTO reactor_effect_receipts
					(effect_id, completed_at, state, started_at)
				VALUES (${effectId}, ${startedAt}, 'started', ${startedAt})
				ON CONFLICT(effect_id) DO NOTHING
				RETURNING effect_id
			`.pipe(Effect.orDie);
			if (inserted.length > 0) return "started";
			const existing = yield* state(effectId);
			if (existing === "started") return "already-started";
			if (existing === "completed" || existing === "outcome-unknown")
				return existing;
			return yield* Effect.die(
				new Error(`Reactor effect ${effectId} disappeared after begin`),
			);
		}),

		markOutcomeUnknown: (effectId: string): Effect.Effect<void> =>
			Effect.gen(function* () {
				const finishedAt = (yield* DateTime.nowAsDate).toISOString();
				yield* sql`
					UPDATE reactor_effect_receipts
					SET state = 'outcome-unknown', completed_at = ${finishedAt}
					WHERE effect_id = ${effectId} AND state = 'started'
				`;
			}).pipe(Effect.orDie),

		/**
		 * Releases a start fence only when the caller has positive evidence that
		 * the external operation was not delivered. This is intentionally narrower
		 * than a generic retry/reset API: an interrupted or uncertain send must keep
		 * its `started` row and recover as `outcome-unknown`.
		 */
		releaseUndelivered: (effectId: string): Effect.Effect<void> =>
			sql`
				DELETE FROM reactor_effect_receipts
				WHERE effect_id = ${effectId} AND state = 'started'
			`.pipe(Effect.asVoid, Effect.orDie),

		complete: (effectId: string): Effect.Effect<void> =>
			Effect.gen(function* () {
				const completedAt = (yield* DateTime.nowAsDate).toISOString();
				yield* sql`
					INSERT INTO reactor_effect_receipts
						(effect_id, completed_at, state, started_at)
					VALUES (${effectId}, ${completedAt}, 'completed', ${completedAt})
					ON CONFLICT(effect_id) DO UPDATE SET
						state = CASE
							WHEN reactor_effect_receipts.state = 'outcome-unknown'
								THEN reactor_effect_receipts.state
							ELSE 'completed'
						END,
						completed_at = CASE
							WHEN reactor_effect_receipts.state = 'outcome-unknown'
								THEN reactor_effect_receipts.completed_at
							ELSE excluded.completed_at
						END
				`;
			}).pipe(Effect.orDie),
	};
};
