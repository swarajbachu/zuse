import { formatNumber, message } from "@zuse/i18n";
import {
	type UsageTokenCounts as TokenRow,
	totalUsageTokens,
} from "@zuse/utils/usage-values";

/**
 * Shared usage formatters. Used by the Tokenmaxer usage dashboard and the
 * onboarding "Maximize" step so both render token/cost numbers identically.
 */

export type { UsageTokenCounts as TokenRow } from "@zuse/utils/usage-values";

/** Compact token count, e.g. 1_234_567 → "1.2M", 1_234 → "1.2k". */
export const formatTokens = (n: number): string =>
	formatNumber(n, { notation: "compact", maximumFractionDigits: 1 });

/** Preserve USD; localization changes presentation, never currency or value. */
export const formatUsd = (n: number | null): string =>
	n === null
		? message("common:notAvailable")
		: formatNumber(n, { style: "currency", currency: "USD" });

/** Sum of every token type on a row. */
export const totalTokens = totalUsageTokens;

/** Anthropic-style cache tokens (read + creation). */
export const cacheTokens = (row: TokenRow): number =>
	row.cacheReadTokens + row.cacheCreationTokens;
