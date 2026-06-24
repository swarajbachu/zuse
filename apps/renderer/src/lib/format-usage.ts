/**
 * Shared usage formatters. Used by the Tokenmaxer usage dashboard and the
 * onboarding "Maximize" step so both render token/cost numbers identically.
 */

export interface TokenRow {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly reasoningTokens: number;
}

/** Compact token count, e.g. 1_234_567 → "1.2M", 1_234 → "1.2k". */
export const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

/** USD with two decimals, or a compact placeholder when cost is unavailable. */
export const formatUsd = (n: number | null): string =>
  n === null ? "N/A" : `$${n.toFixed(2)}`;

/** Sum of every token type on a row. */
export const totalTokens = (row: TokenRow): number =>
  row.inputTokens +
  row.outputTokens +
  row.cacheReadTokens +
  row.cacheCreationTokens +
  row.reasoningTokens;

/** Anthropic-style cache tokens (read + creation). */
export const cacheTokens = (row: TokenRow): number =>
  row.cacheReadTokens + row.cacheCreationTokens;
