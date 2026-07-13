import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
	type FolderId,
	MemoizeRpcs,
	type ProviderId,
	ProviderUsageLimits as ProviderUsageLimitsSchema,
	UsageLimitHistoryPoint as UsageLimitHistoryPointSchema,
	UsageOverview as UsageOverviewSchema,
	UsageReport as UsageReportSchema,
	UsageSessionsPage as UsageSessionsPageSchema,
} from "@zuse/contracts";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
	buildUsageReport,
	groupUsageRecords,
	type UsageSourceId,
} from "tokenmaxer";

import { AppPaths } from "../app-paths.ts";
import {
	ensureSqliteRenameCompatibility,
	sqliteDbPath,
} from "../persistence/db-path.ts";
import {
	loadAndMergePersistedDaily,
	persistDailyAggregates,
	persistPricedUsageOnce,
	resetPersistedPricedUsageForTest,
} from "./cost-history.ts";
import { mergeUsageLimits } from "./limits/merge.ts";
import { recordLimitSnapshots } from "./limits/recorder.ts";
import { loadUsageLimitsCached } from "./limits/service.ts";
import { loadSessionUsageWindows } from "./limits/session-events.ts";
import {
	loadPricedUsageCached,
	resetUsageReportCacheForTest as resetPricedUsageCacheForTest,
} from "./report-cache.ts";

/** Sessions table is paginated client-side; cap the payload to the heaviest N. */
const MAX_SESSIONS_IN_PAYLOAD = 250;

const sessionTokens = (s: {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	reasoningTokens: number;
}): number =>
	s.inputTokens +
	s.outputTokens +
	s.cacheReadTokens +
	s.cacheCreationTokens +
	s.reasoningTokens;

export const paginateUsageSessions = <
	T extends {
		readonly label: string;
		readonly startedAt: Date | null;
		readonly endedAt: Date | null;
		readonly costUsd: number | null;
		readonly inputTokens: number;
		readonly outputTokens: number;
		readonly cacheReadTokens: number;
		readonly cacheCreationTokens: number;
		readonly reasoningTokens: number;
	},
>(
	rows: ReadonlyArray<T>,
	options: {
		readonly query?: string;
		readonly sort: "tokens" | "cost" | "last-active";
		readonly offset: number;
		readonly limit: number;
	},
) => {
	const query = options.query?.trim().toLocaleLowerCase() ?? "";
	const filtered =
		query.length === 0
			? rows.slice()
			: rows.filter((row) => row.label.toLocaleLowerCase().includes(query));
	filtered.sort((a, b) => {
		if (options.sort === "cost") return (b.costUsd ?? 0) - (a.costUsd ?? 0);
		if (options.sort === "last-active")
			return (
				(b.endedAt?.getTime() ?? b.startedAt?.getTime() ?? 0) -
				(a.endedAt?.getTime() ?? a.startedAt?.getTime() ?? 0)
			);
		return sessionTokens(b) - sessionTokens(a);
	});
	const rowsPage = filtered.slice(
		options.offset,
		options.offset + options.limit,
	);
	const next = options.offset + rowsPage.length;
	return {
		rows: rowsPage,
		total: filtered.length,
		nextOffset: next < filtered.length ? next : null,
	};
};
export const resetUsageReportCacheForTest = (): void => {
	resetPricedUsageCacheForTest();
	resetPersistedPricedUsageForTest();
	overviewProjectionCache.clear();
	overviewProjectionMetrics.hits = 0;
	overviewProjectionMetrics.misses = 0;
};

export const trimUsageReportForPayload = (
	report: ReturnType<typeof buildUsageReport>,
) => {
	// The renderer never reads per-record rows, and the sessions table is
	// paginated client-side — trim both so the RPC payload stays small.
	const bySession = report.bySession
		.slice()
		.sort((a, b) => sessionTokens(b) - sessionTokens(a))
		.slice(0, MAX_SESSIONS_IN_PAYLOAD);
	return { ...report, records: [], bySession };
};

const encodeUsageGroup = <
	T extends { startedAt: Date | null; endedAt: Date | null },
>(
	group: T,
) => ({
	...group,
	startedAt: group.startedAt?.toISOString() ?? null,
	endedAt: group.endedAt?.toISOString() ?? null,
});

export const prepareUsageReportForRpc = (
	report: ReturnType<typeof buildUsageReport>,
): typeof UsageReportSchema.Type => {
	const trimmed = trimUsageReportForPayload(report);
	const encoded = {
		...trimmed,
		generatedAt: trimmed.generatedAt.toISOString(),
		groups: trimmed.groups.map(encodeUsageGroup),
		bySource: trimmed.bySource.map(encodeUsageGroup),
		byModel: trimmed.byModel.map(encodeUsageGroup),
		bySession: trimmed.bySession.map(encodeUsageGroup),
		records: [],
	};
	return Schema.decodeUnknownSync(UsageReportSchema)(encoded);
};

const groupUsageByProject = (
	records: ReturnType<typeof buildUsageReport>["records"],
) =>
	groupUsageRecords(
		records.filter(
			(record) => (record.projectPath ?? record.workspacePath) !== null,
		),
		(record) => (record.projectPath ?? record.workspacePath) as string,
		(_record, path) => basename(path) || path,
	)
		.slice()
		.sort((a, b) => sessionTokens(b) - sessionTokens(a));

export const prepareUsageOverviewForRpc = (
	report: ReturnType<typeof buildUsageReport>,
	previous: ReturnType<typeof buildUsageReport> | null,
): typeof UsageOverviewSchema.Type =>
	Schema.decodeUnknownSync(UsageOverviewSchema)({
		bucket: report.bucket,
		generatedAt: report.generatedAt.toISOString(),
		summary: report.summary,
		sessionCount: report.bySession.length,
		previousSummary: previous?.summary ?? null,
		previousSessionCount: previous?.bySession.length ?? null,
		groups: report.groups.map(encodeUsageGroup),
		bySource: report.bySource.map(encodeUsageGroup),
		byModel: report.byModel.map(encodeUsageGroup),
		byProject: groupUsageByProject(report.records).map(encodeUsageGroup),
		previousBySource: (previous?.bySource ?? []).map(encodeUsageGroup),
		previousByModel: (previous?.byModel ?? []).map(encodeUsageGroup),
		previousByProject: groupUsageByProject(previous?.records ?? []).map(
			encodeUsageGroup,
		),
		sources: report.sources,
	});

/**
 * Path roots that scope a report to a single codebase. Agents run in Memoize
 * worktrees at `~/.zuse/<name>-<id-prefix>/<worktree>` (not the project's
 * own repo path), so we match both the repo path and that worktree root.
 */
const projectPathsFor = (projectId: FolderId | undefined) =>
	Effect.gen(function* () {
		if (projectId === undefined) return undefined;
		const sql = yield* SqlClient.SqlClient;
		const rows = yield* sql<{ path: string; name: string }>`
      SELECT path, name FROM projects WHERE id = ${projectId} LIMIT 1
    `;
		const project = rows[0];
		if (project === undefined) return undefined;
		const worktreeRoot = join(
			homedir(),
			".zuse",
			`${project.name}-${projectId.slice(0, 8)}`,
		);
		return [project.path, worktreeRoot];
	});

type UsageReportOptions = {
	readonly bucket: "daily" | "weekly" | "monthly" | "session";
	readonly sourceIds?: ReadonlyArray<UsageSourceId>;
	readonly providerIds?: ReadonlyArray<ProviderId>;
	readonly since?: Date;
	readonly until?: Date;
	readonly timezone?: string;
	readonly projectId?: FolderId;
	readonly includePossibleDuplicates?: boolean;
	readonly forceRefresh?: boolean;
	readonly loadPriced?: NonNullable<
		Parameters<typeof loadPricedUsageCached>[2]
	>["load"];
};

const loadUsageReportData = (
	options: Pick<
		UsageReportOptions,
		"projectId" | "forceRefresh" | "loadPriced"
	>,
) =>
	Effect.gen(function* () {
		const paths = yield* AppPaths;
		const projectPaths = yield* projectPathsFor(options.projectId).pipe(
			Effect.catch(() => Effect.succeed(undefined)),
		);
		yield* ensureSqliteRenameCompatibility(paths.userData).pipe(Effect.orDie);
		const priced = yield* Effect.tryPromise(() =>
			loadPricedUsageCached(
				sqliteDbPath(paths.userData),
				join(paths.userData, "tokenmaxer"),
				{ forceRefresh: options.forceRefresh, load: options.loadPriced },
			),
		).pipe(Effect.orDie);
		yield* persistPricedUsageOnce(priced, persistDailyAggregates).pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning(
					`[usage] daily aggregate persistence failed; it will retry: ${String(cause)}`,
				),
			),
		);
		const merged = yield* loadAndMergePersistedDaily(priced).pipe(
			Effect.catch(() => Effect.succeed(priced)),
		);
		return { merged, projectPaths };
	});

const buildReportFromData = (
	data: Effect.Success<ReturnType<typeof loadUsageReportData>>,
	options: UsageReportOptions,
) =>
	buildUsageReport({
		records: data.merged.records,
		sources: data.merged.sources,
		bucket: options.bucket,
		filters: {
			bucket: options.bucket,
			sourceIds: options.sourceIds,
			providerIds: options.providerIds,
			since: options.since,
			until: options.until,
			timezone: options.timezone,
			projectPaths: data.projectPaths,
			includePossibleDuplicates: options.includePossibleDuplicates,
		},
	});

const loadReportForRequest = (options: UsageReportOptions) =>
	Effect.gen(function* () {
		const data = yield* loadUsageReportData(options);
		return buildReportFromData(data, options);
	});

const UsageReport = MemoizeRpcs.toLayerHandler(
	"usage.report",
	({
		bucket,
		sourceIds,
		since,
		until,
		timezone,
		projectId,
		includePossibleDuplicates,
		forceRefresh,
	}) =>
		Effect.gen(function* () {
			const report = yield* loadReportForRequest({
				bucket: bucket ?? "daily",
				sourceIds: sourceIds as ReadonlyArray<UsageSourceId> | undefined,
				since,
				until,
				timezone,
				projectId,
				includePossibleDuplicates,
				forceRefresh,
			});
			return prepareUsageReportForRpc(report);
		}),
);

const buildUsageOverview = (options: {
	readonly since?: Date;
	readonly until?: Date;
	readonly timezone?: string;
	readonly projectId?: FolderId;
	readonly forceRefresh?: boolean;
	readonly loadPriced?: NonNullable<
		Parameters<typeof loadPricedUsageCached>[2]
	>["load"];
}) =>
	Effect.gen(function* () {
		const startedAt = performance.now();
		const data = yield* loadUsageReportData(options);
		const report = buildReportFromData(data, {
			bucket: "daily",
			since: options.since,
			until: options.until,
			timezone: options.timezone,
			projectId: options.projectId,
			forceRefresh: options.forceRefresh,
		});
		const previous =
			options.since === undefined
				? null
				: buildReportFromData(data, {
						bucket: "daily",
						since: new Date(
							options.since.getTime() -
								((options.until?.getTime() ?? Date.now()) -
									options.since.getTime()),
						),
						until: options.since,
						timezone: options.timezone,
						projectId: options.projectId,
					});
		const overview = prepareUsageOverviewForRpc(report, previous);
		yield* Effect.logDebug(
			`[usage] overview projected in ${Math.round(performance.now() - startedAt)}ms (${JSON.stringify(overview).length} bytes)`,
		);
		return overview;
	});

const overviewProjectionCache = new Map<
	string,
	ReturnType<typeof buildUsageOverview>
>();
export const overviewProjectionMetrics = { hits: 0, misses: 0 };
const MAX_OVERVIEW_PROJECTIONS = 64;

const overviewKey = (options: Parameters<typeof buildUsageOverview>[0]) =>
	[
		options.projectId ?? "global",
		options.since?.toISOString() ?? "",
		options.until?.toISOString() ?? "",
		options.timezone ?? "",
	].join(":");

export const loadUsageOverviewCached = (
	options: Parameters<typeof buildUsageOverview>[0],
) => {
	if (options.forceRefresh) {
		overviewProjectionCache.delete(overviewKey(options));
		overviewProjectionMetrics.misses += 1;
		return buildUsageOverview(options);
	}
	const key = overviewKey(options);
	const cached = overviewProjectionCache.get(key);
	if (cached) {
		overviewProjectionMetrics.hits += 1;
		return cached;
	}
	overviewProjectionMetrics.misses += 1;
	const projection = Effect.runSync(
		Effect.cachedWithTTL(buildUsageOverview(options), "60 seconds"),
	);
	if (overviewProjectionCache.size >= MAX_OVERVIEW_PROJECTIONS) {
		const oldest = overviewProjectionCache.keys().next().value;
		if (oldest !== undefined) overviewProjectionCache.delete(oldest);
	}
	overviewProjectionCache.set(key, projection);
	return projection;
};

const UsageOverview = MemoizeRpcs.toLayerHandler("usage.overview", (options) =>
	loadUsageOverviewCached(options),
);

const UsageSessions = MemoizeRpcs.toLayerHandler(
	"usage.sessions",
	({
		since,
		until,
		timezone,
		projectId,
		query,
		providerId,
		sort,
		offset,
		limit,
	}) =>
		Effect.gen(function* () {
			const report = yield* loadReportForRequest({
				bucket: "session",
				since,
				until,
				timezone,
				projectId,
				providerIds: providerId === undefined ? undefined : [providerId],
			});
			const page = paginateUsageSessions(report.bySession, {
				query,
				sort: sort ?? "tokens",
				offset: Math.max(0, offset ?? 0),
				limit: Math.min(100, Math.max(1, limit ?? 10)),
			});
			return Schema.decodeUnknownSync(UsageSessionsPageSchema)({
				...page,
				rows: page.rows.map(encodeUsageGroup),
			});
		}),
);

const UsageLimits = MemoizeRpcs.toLayerHandler(
	"usage.limits",
	({ forceRefresh, providerId }) =>
		Effect.gen(function* () {
			const events = yield* loadSessionUsageWindows.pipe(
				Effect.catch(() => Effect.succeed([])),
			);
			const providers = yield* Effect.tryPromise(() =>
				loadUsageLimitsCached(forceRefresh, providerId),
			).pipe(Effect.orDie);
			const merged = mergeUsageLimits(
				providers,
				providerId === undefined
					? events
					: events.filter((event) => event.providerId === providerId),
			);
			yield* recordLimitSnapshots(merged).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning(
						`[usage] limit snapshot persistence failed: ${String(cause)}`,
					),
				),
			);
			return {
				providers: merged.map((provider) =>
					Schema.decodeUnknownSync(ProviderUsageLimitsSchema)(provider),
				),
			};
		}),
);

const UsageLimitsHistory = MemoizeRpcs.toLayerHandler(
	"usage.limits.history",
	({ providerId, since }) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const cutoff = (
				since ?? new Date(Date.now() - 30 * 86_400_000)
			).toISOString();
			const rows = providerId
				? yield* sql<{
						provider_id: ProviderId;
						window_id: string;
						captured_hour: string;
						used_percent: number | null;
					}>`SELECT provider_id, window_id, captured_hour, used_percent FROM usage_limit_snapshots WHERE captured_hour >= ${cutoff} AND provider_id = ${providerId} ORDER BY captured_hour ASC`
				: yield* sql<{
						provider_id: ProviderId;
						window_id: string;
						captured_hour: string;
						used_percent: number | null;
					}>`SELECT provider_id, window_id, captured_hour, used_percent FROM usage_limit_snapshots WHERE captured_hour >= ${cutoff} ORDER BY captured_hour ASC`;
			return {
				points: rows.map((row) =>
					Schema.decodeUnknownSync(UsageLimitHistoryPointSchema)({
						providerId: row.provider_id,
						windowId: row.window_id,
						capturedAt: row.captured_hour,
						usedPercent: row.used_percent,
					}),
				),
			};
		}).pipe(Effect.orDie),
);

export const UsageHandlersLayer = Layer.mergeAll(
	UsageReport,
	UsageOverview,
	UsageSessions,
	UsageLimits,
	UsageLimitsHistory,
);
