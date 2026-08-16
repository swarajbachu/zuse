import { DateTime, Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";

/** Durable at-most-once receipt boundary for non-transactional reactor work. */
export const makeReactorEffectJournal = (sql: SqlClient.SqlClient) => ({
  isCompleted: Effect.fn("ReactorEffectJournal.isCompleted")(function* (
    effectId: string,
  ) {
    const rows = yield* sql<{ readonly effect_id: string }>`
      SELECT effect_id FROM reactor_effect_receipts
      WHERE effect_id = ${effectId}
      LIMIT 1
    `.pipe(Effect.orDie);
    return rows.length > 0;
  }),

  complete: (effectId: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const completedAt = (yield* DateTime.nowAsDate).toISOString();
      yield* sql`
        INSERT OR IGNORE INTO reactor_effect_receipts
          (effect_id, completed_at)
        VALUES (${effectId}, ${completedAt})
      `;
    }).pipe(Effect.orDie),
});
