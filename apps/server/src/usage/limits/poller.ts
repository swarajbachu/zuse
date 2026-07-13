import { Effect, Layer, Schedule } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { recordLimitSnapshots } from "./recorder.ts";
import { loadUsageLimitsCached } from "./service.ts";

const poll = Effect.gen(function* () {
	const providers = yield* Effect.tryPromise(() =>
		loadUsageLimitsCached(false),
	);
	yield* recordLimitSnapshots(providers);
}).pipe(Effect.catch(() => Effect.void));
export const UsageLimitsPollerLive = Layer.effectDiscard(
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`DELETE FROM usage_limit_snapshots WHERE captured_hour < datetime('now', '-2 years')`;
		yield* Effect.forkScoped(
			Effect.repeat(
				poll,
				Schedule.spaced("30 minutes").pipe(Schedule.jittered),
			),
		);
	}),
);
