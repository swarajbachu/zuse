import { SqlClient } from "effect/unstable/sql";
import { MemoizeRpcs, type FolderId } from "@zuse/wire";
import {
  buildUsageReport,
  loadPricedUsage,
  type PricedUsage,
  type UsageSourceId,
} from "tokenmaxer";
import { Effect, Layer } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";

import { AppPaths } from "../app-paths.ts";
import {
  ensureSqliteRenameCompatibility,
  sqliteDbPath,
} from "../persistence/db-path.ts";

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

export const resetUsageReportCacheForTest = (): void => {
  pricedCache = null;
  pricedInFlight = null;
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
      const paths = yield* AppPaths;
      const projectPaths = yield* projectPathsFor(projectId).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      yield* ensureSqliteRenameCompatibility(paths.userData).pipe(Effect.orDie);
      return yield* Effect.tryPromise(async () => {
        const { records, sources } = await loadPricedUsageCached(
          sqliteDbPath(paths.userData),
          join(paths.userData, "tokenmaxer"),
          { forceRefresh },
        );
        const report = buildUsageReport({
          records,
          sources,
          bucket: bucket ?? "daily",
          filters: {
            bucket: bucket ?? "daily",
            sourceIds: sourceIds as ReadonlyArray<UsageSourceId> | undefined,
            since,
            until,
            timezone,
            projectPaths,
            includePossibleDuplicates,
          },
        });
        return trimUsageReportForPayload(report);
      }).pipe(Effect.orDie);
    }),
);

export const UsageHandlersLayer = Layer.mergeAll(UsageReport);
