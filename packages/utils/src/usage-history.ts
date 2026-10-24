/** One hourly usage-history row as uploaded to the account backup. */
export interface UsageHistoryRowShape {
	readonly hour: string;
	readonly model: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheCreationTokens: number;
	readonly reasoningTokens: number;
	readonly costUsd: number | null;
	readonly recordCount: number;
	readonly firstAt: number;
	readonly lastAt: number;
}

const HOUR_MS = 60 * 60 * 1_000;
const MAX_ROW_SPAN_MS = 7 * 24 * HOUR_MS;
const MAX_FUTURE_MS = 2 * HOUR_MS;
const MIN_HOUR_MS = Date.UTC(2020, 0, 1);
const MAX_COST_USD = 1_000_000_000;
const isCount = (value: number) => Number.isSafeInteger(value) && value >= 0;

/**
 * The backup API's per-row rules, shared so the desktop can skip rows the API
 * would reject instead of letting one bad row fail every later upload.
 */
export const validUsageHistoryRow = (
	row: UsageHistoryRowShape,
	now: number,
): boolean => {
	const hour = Date.parse(row.hour);
	return (
		Number.isFinite(hour) &&
		new Date(hour).toISOString() === row.hour &&
		hour >= MIN_HOUR_MS &&
		hour <= now + MAX_FUTURE_MS &&
		row.model.length >= 1 &&
		row.model.length <= 100 &&
		[
			row.inputTokens,
			row.outputTokens,
			row.cacheReadTokens,
			row.cacheCreationTokens,
			row.reasoningTokens,
			row.recordCount,
			row.firstAt,
			row.lastAt,
		].every(isCount) &&
		(row.costUsd === null ||
			(Number.isFinite(row.costUsd) &&
				row.costUsd >= 0 &&
				row.costUsd <= MAX_COST_USD)) &&
		row.recordCount >= 1 &&
		row.firstAt >= hour &&
		row.firstAt < hour + HOUR_MS &&
		row.firstAt <= row.lastAt &&
		row.lastAt <= row.firstAt + MAX_ROW_SPAN_MS
	);
};
