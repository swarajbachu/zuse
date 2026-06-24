import { buildUsageReport } from "./aggregate.ts";
import { priceRecordsAsync } from "./cost-pass.ts";
import { withDuplicateFlags } from "./normalize.ts";
import type { LoadPricingOptions } from "./pricing/litellm.ts";
import { EXTERNAL_SOURCE_IDS } from "./sources/catalog.ts";
import { readMemoizeUsage } from "./sources/memoize.ts";
import { readExternalSource } from "./sources/registry.ts";
import type {
  UsageBucket,
  UsageFilters,
  UsageReadOptions,
  UsageReport,
  UsageSourceId,
  UsageSourceReadResult,
} from "./types.ts";

export const readUsageSources = async (
  options: UsageReadOptions = {},
): Promise<ReadonlyArray<UsageSourceReadResult>> => {
  const selected = new Set<UsageSourceId>(options.sourceIds ?? ["memoize", ...EXTERNAL_SOURCE_IDS]);
  const results: UsageSourceReadResult[] = [];
  if (selected.has("memoize")) {
    results.push(readMemoizeUsage(options.memoizeDbPath));
  }
  // Read external sources sequentially so each one's file scan yields to the
  // event loop in turn rather than flooding it; keeps the host responsive.
  for (const sourceId of EXTERNAL_SOURCE_IDS) {
    if (!selected.has(sourceId) || sourceId === "memoize") continue;
    results.push(await readExternalSource(sourceId, options));
  }
  return results;
};

export interface PricedUsage {
  readonly records: ReadonlyArray<import("./types.ts").UsageRecord>;
  readonly sources: ReadonlyArray<import("./types.ts").UsageSourceStatus>;
}

/**
 * Read every selected source from disk and price the records. This is the
 * expensive step (file scans + pricing); callers that re-report across buckets
 * or project scopes should cache the result and feed it to {@link buildUsageReport}
 * rather than calling {@link createUsageReport} repeatedly.
 */
export const loadPricedUsage = async (input: {
  readOptions?: UsageReadOptions;
  pricing?: LoadPricingOptions;
} = {}): Promise<PricedUsage> => {
  const results = await readUsageSources(input.readOptions);
  const priced = await priceRecordsAsync(
    results.flatMap((r) => r.records),
    input.pricing,
  );
  return {
    records: withDuplicateFlags(priced),
    sources: results.map((r) => r.status),
  };
};

export const createUsageReport = async (input: {
  bucket?: UsageBucket;
  filters?: UsageFilters;
  readOptions?: UsageReadOptions;
  pricing?: LoadPricingOptions;
} = {}): Promise<UsageReport> => {
  const { records, sources } = await loadPricedUsage(input);
  return buildUsageReport({
    records,
    sources,
    bucket: input.bucket ?? input.filters?.bucket ?? "daily",
    filters: input.filters,
  });
};
