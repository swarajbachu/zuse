import { join } from "node:path";
import { Effect, Layer, Schedule } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppPaths } from "../../app-paths.ts";
import { sqliteDbPath } from "../../persistence/db-path.ts";
import {
	persistDailyAggregates,
	persistPricedUsageOnce,
} from "../cost-history.ts";
import { loadPricedUsageCached } from "../report-cache.ts";
import { mergeUsageLimits, type SessionUsageWindow } from "./merge.ts";
import { recordLimitSnapshots } from "./recorder.ts";
import { loadUsageLimitsForPoll, type PolledProviderId } from "./service.ts";
import { loadSessionUsageWindows } from "./session-events.ts";

const POLL_PROVIDER_IDS: ReadonlyArray<PolledProviderId> = [
	"claude",
	"codex",
	"grok",
	"gemini",
];
const FRESH_SESSION_WINDOW_MS = 30 * 60 * 1_000;
const DAILY_COST_PERSIST_INTERVAL_MS = 6 * 60 * 60 * 1_000;
let lastDailyCostPersistAt = 0;

export const shouldPersistDailyCosts = (
	now: number,
	lastPersistedAt: number,
): boolean => now - lastPersistedAt >= DAILY_COST_PERSIST_INTERVAL_MS;

export const providerIdsForUsagePoll = (
	events: readonly SessionUsageWindow[],
	now = Date.now(),
): ReadonlyArray<PolledProviderId> => {
	const hasFreshCodexWindow = events.some(
		(event) =>
			event.providerId === "codex" &&
			now - Date.parse(event.createdAt) < FRESH_SESSION_WINDOW_MS,
	);
	return hasFreshCodexWindow
		? POLL_PROVIDER_IDS.filter((providerId) => providerId !== "codex")
		: POLL_PROVIDER_IDS;
};

const poll = Effect.gen(function* () {
	const now = Date.now();
	const events = yield* loadSessionUsageWindows.pipe(
		Effect.catchCause((cause) =>
			Effect.logWarning(
				`[usage] session-window lookup failed during poll: ${String(cause)}`,
			).pipe(Effect.as([] as SessionUsageWindow[])),
		),
	);
	const providerIds = providerIdsForUsagePoll(events);
	const providers = yield* Effect.tryPromise(() =>
		loadUsageLimitsForPoll(providerIds),
	);
	yield* recordLimitSnapshots(mergeUsageLimits(providers, events));
	if (shouldPersistDailyCosts(now, lastDailyCostPersistAt)) {
		const paths = yield* AppPaths;
		const priced = yield* Effect.tryPromise(() =>
			loadPricedUsageCached(
				sqliteDbPath(paths.userData),
				join(paths.userData, "tokenmaxer"),
			),
		);
		yield* persistPricedUsageOnce(priced, persistDailyAggregates);
		lastDailyCostPersistAt = now;
	}
}).pipe(
	Effect.catchCause((cause) =>
		Effect.logWarning(`[usage] limits poll failed: ${String(cause)}`),
	),
);
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
