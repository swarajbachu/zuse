import type { TokenCounts } from "../types.ts";
import type { ModelPricing } from "./litellm.ts";

const TIERED_THRESHOLD = 200_000;

/**
 * Tiered per-token cost: tokens above the 200k threshold are charged at the
 * tiered rate when present. Ported from ccusage `calculateTieredCost`.
 */
const tieredCost = (
  tokens: number,
  basePrice: number | undefined,
  tieredPrice: number | undefined,
): number => {
  if (tokens <= 0) return 0;
  if (tokens > TIERED_THRESHOLD && tieredPrice !== undefined) {
    let cost = (tokens - TIERED_THRESHOLD) * tieredPrice;
    if (basePrice !== undefined) cost += TIERED_THRESHOLD * basePrice;
    return cost;
  }
  return basePrice !== undefined ? tokens * basePrice : 0;
};

/**
 * Cost in USD for token counts against a resolved pricing entry. `inputTokens`
 * must be exclusive of cache tokens (sources are normalized that way), so the
 * four token types are priced independently. `fast` applies the provider fast
 * multiplier. Reasoning tokens are not billed separately.
 */
export const costFromPricing = (
  counts: TokenCounts,
  pricing: ModelPricing,
  fast = false,
): number => {
  const base =
    tieredCost(counts.inputTokens, pricing.input_cost_per_token, pricing.input_cost_per_token_above_200k_tokens) +
    tieredCost(counts.outputTokens, pricing.output_cost_per_token, pricing.output_cost_per_token_above_200k_tokens) +
    tieredCost(
      counts.cacheCreationTokens,
      pricing.cache_creation_input_token_cost,
      pricing.cache_creation_input_token_cost_above_200k_tokens,
    ) +
    tieredCost(
      counts.cacheReadTokens,
      pricing.cache_read_input_token_cost,
      pricing.cache_read_input_token_cost_above_200k_tokens,
    );
  return fast ? base * (pricing.provider_specific_entry?.fast ?? 1) : base;
};

export const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

export const formatUsd = (n: number | null): string =>
  n === null ? "unknown" : `$${n.toFixed(2)}`;
