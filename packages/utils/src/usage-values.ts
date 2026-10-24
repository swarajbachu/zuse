/** API snapshots express percentages; streamed Claude events express fractions. */
export const normalizePercent = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value)
		? Math.min(100, Math.max(0, value))
		: null;
export const fractionToPercent = (value: unknown): number | null =>
	typeof value === "number" ? normalizePercent(value * 100) : null;

export const normalizeReset = (value: unknown): string | null => {
	if (typeof value === "string") {
		const ms = Date.parse(value);
		return Number.isNaN(ms) ? null : new Date(ms).toISOString();
	}
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const ms = value < 10_000_000_000 ? value * 1_000 : value;
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export interface UsageTokenCounts {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheCreationTokens: number;
	readonly reasoningTokens: number;
}

/** Token categories reported by usage tools, including cache and reasoning. */
export const totalUsageTokens = (row: UsageTokenCounts): number =>
	row.inputTokens +
	row.outputTokens +
	row.cacheReadTokens +
	row.cacheCreationTokens +
	row.reasoningTokens;
