import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
	type FolderId,
	MemoizeRpcs,
	ProviderUsageLimits as ProviderUsageLimitsSchema,
	UsageOverview as UsageOverviewSchema,
	UsageReport as UsageReportSchema,
	UsageSessionsPage as UsageSessionsPageSchema,
} from "@zuse/contracts";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
	buildUsageReport,
	groupUsageRecords,
	loadPricedUsage,
	type PricedUsage,
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
} from "./cost-history.ts";
import { mergeUsageLimits } from "./limits/merge.ts";
import { recordLimitSnapshots } from "./limits/recorder.ts";
import { loadUsageLimitsCached } from "./limits/service.ts";
import { loadSessionUsageWindows } from "./limits/session-events.ts";

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
/** Re-scanning the agent log dirs on every bucket/scope switch is what makes
 * the dashboard feel laggy. Cache the priced records briefly so only the first
 * load (or a manual refresh after the TTL) touches disk. */
const PRICED_CACHE_TTL_MS = 60_000;

let pricedCache: { readonly at: number; readonly value: PricedUsage } | null =
	null;
let pricedInFlight: {
	readonly forceRefresh: boolean;
	readonly promise: Promise<PricedUsage>;
} | null = null;
let persistedPricedValue: PricedUsage | null = null;

export const resetUsageReportCacheForTest = (): void => {
	pricedCache = null;
	pricedInFlight = null;
	persistedPricedValue = null;
};

export const loadPricedUsageCached = (
	zuseDbPath: string,
	cacheDir: string,
	opts: {
		readonly forceRefresh?: boolean;
		readonly load?: typeof loadPricedUsage;
		readonly now?: () => number;
	} = {},
): Promise<PricedUsage> => {
	const forceRefresh = opts.forceRefresh === true;
	const now = (opts.now ?? Date.now)();
	if (
		!forceRefresh &&
		pricedCache !== null &&
		now - pricedCache.at < PRICED_CACHE_TTL_MS
	) {
		return Promise.resolve(pricedCache.value);
	}
	if (
		pricedInFlight !== null &&
		(!forceRefresh || pricedInFlight.forceRefresh)
	) {
		return pricedInFlight.promise;
	}
	const load = opts.load ?? loadPricedUsage;
	const promise = load({
		readOptions: { zuseDbPath },
		pricing: { cacheDir },
	})
		.then((value) => {
			pricedCache = { at: (opts.now ?? Date.now)(), value };
			return value;
		})
		.finally(() => {
			if (pricedInFlight?.promise === promise) {
				pricedInFlight = null;
			}
		});
	pricedInFlight = { forceRefresh, promise };
	return promise;
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

const loadReportForRequest = (options: {
	readonly bucket: "daily" | "weekly" | "monthly" | "session";
	readonly sourceIds?: ReadonlyArray<UsageSourceId>;
	readonly providerIds?: ReadonlyArray<string>;
	readonly since?: Date;
	readonly until?: Date;
	readonly timezone?: string;
	readonly projectId?: FolderId;
	readonly includePossibleDuplicates?: boolean;
	readonly forceRefresh?: boolean;
}) =>
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
				{ forceRefresh: options.forceRefresh },
			),
		).pipe(Effect.orDie);
		if (persistedPricedValue !== priced) {
			yield* persistDailyAggregates(priced).pipe(
				Effect.catch(() => Effect.void),
			);
			persistedPricedValue = priced;
		}
		const merged = yield* loadAndMergePersistedDaily(priced).pipe(
			Effect.catch(() => Effect.succeed(priced)),
		);
		return buildUsageReport({
			records: merged.records,
			sources: merged.sources,
			bucket: options.bucket,
			filters: {
				bucket: options.bucket,
				sourceIds: options.sourceIds,
				providerIds: options.providerIds,
				since: options.since,
				until: options.until,
				timezone: options.timezone,
				projectPaths,
				includePossibleDuplicates: options.includePossibleDuplicates,
			},
		});
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

const UsageOverview = MemoizeRpcs.toLayerHandler(
	"usage.overview",
	({ since, until, timezone, projectId, forceRefresh }) =>
		Effect.gen(function* () {
			const report = yield* loadReportForRequest({
				bucket: "daily",
				since,
				until,
				timezone,
				projectId,
				forceRefresh,
			});
			const previous =
				since === undefined
					? null
					: yield* loadReportForRequest({
							bucket: "daily",
							since: new Date(
								since.getTime() -
									((until?.getTime() ?? Date.now()) - since.getTime()),
							),
							until: since,
							timezone,
							projectId,
						});
			return Schema.decodeUnknownSync(UsageOverviewSchema)({
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
		}),
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
			yield* recordLimitSnapshots(merged).pipe(Effect.catch(() => Effect.void));
			return {
				providers: merged.map((provider) =>
					Schema.decodeUnknownSync(ProviderUsageLimitsSchema)(provider),
				),
			};
		}),
);

export const UsageHandlersLayer = Layer.mergeAll(
	UsageReport,
	UsageOverview,
	UsageSessions,
	UsageLimits,
);
