import { costFromPricing } from "./pricing/cost.ts";
import { loadPricingTable, type LoadPricingOptions, type PricingTable } from "./pricing/litellm.ts";
import { createModelMatcher } from "./pricing/match.ts";
import type { UsageRecord } from "./types.ts";

/**
 * Price a batch of parsed records using LiteLLM pricing (cost mode `auto`):
 * prefer the source-logged cost, else compute from tokens × model price. An
 * unmatched model leaves the cost `null` ("unknown") so totals stay honest.
 */
export const priceRecords = (
  records: ReadonlyArray<UsageRecord>,
  table: PricingTable,
): UsageRecord[] => {
  const match = createModelMatcher(table);
  return records.map((record) => {
    if (record.loggedCostUsd !== null) {
      return { ...record, costUsd: record.loggedCostUsd, costStatus: "known" as const };
    }
    const pricing = match(record.model);
    if (pricing === null) {
      return { ...record, costUsd: null, costStatus: "unknown" as const };
    }
    return {
      ...record,
      costUsd: costFromPricing(record, pricing, record.fast),
      costStatus: "known" as const,
    };
  });
};

/** Convenience wrapper that resolves the pricing table then prices records. */
export const priceRecordsAsync = async (
  records: ReadonlyArray<UsageRecord>,
  options?: LoadPricingOptions,
): Promise<UsageRecord[]> => {
  const table = await loadPricingTable(options);
  return priceRecords(records, table);
};
