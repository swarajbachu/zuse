import { totalUsageTokens, type UsageTokenCounts } from "./usage-values.ts";
/** Public profiles deliberately contain only aggregate counts and explicit identity. */
export interface UsageProfileTokenShare {
	readonly name: string;
	readonly tokens: number;
}
export interface UsageProfileSnapshot {
	readonly year: number;
	readonly generatedAt: string;
	readonly sessionCount: number;
	readonly days: ReadonlyArray<{
		readonly date: string;
		readonly tokens: number;
	}>;
	readonly models: ReadonlyArray<UsageProfileTokenShare>;
	readonly breakdown: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly reasoning: number;
	};
	/** Tool that recorded the usage, e.g. `claude` or `codex`. */
	readonly sources: ReadonlyArray<{
		readonly id: string;
		readonly label: string;
		readonly tokens: number;
	}>;
	/** Model mix per UTC month (1–12), top models plus a remainder. */
	readonly months: ReadonlyArray<{
		readonly month: number;
		readonly models: ReadonlyArray<UsageProfileTokenShare>;
	}>;
	readonly projectCount: number;
	readonly sessionMinutes: {
		readonly median: number;
		readonly longest: number;
	};
	/** Opt-in: API-equivalent cost estimate. */
	readonly cost: { readonly usd: number; readonly complete: boolean } | null;
	/** Opt-in: tokens per hour of day in the publisher's local time. */
	readonly hours: ReadonlyArray<number> | null;
}

export const usageProfileUrl = (handle: string) =>
	`https://zuse.sh/u/${encodeURIComponent(handle)}`;

const OTHER_MODELS = "Other models";
const MAX_MODELS = 64;
const MAX_MONTH_MODELS = 9;
/** Daily rows restored from the aggregate table carry no real time of day or session. */
const PERSISTED_DAILY = "persisted-daily";

/** Rank token totals and fold everything past `limit - 1` into one remainder row. */
const rankShares = (
	totals: ReadonlyMap<string, number>,
	limit: number,
): UsageProfileTokenShare[] => {
	const ranked = [...totals]
		.filter(([, tokens]) => tokens > 0)
		.map(([name, tokens]) => ({ name, tokens }))
		.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
	if (ranked.length <= limit) return ranked;
	const kept = ranked.slice(0, limit - 1);
	const remainder = ranked
		.slice(limit - 1)
		.reduce((sum, row) => sum + row.tokens, 0);
	const other = kept.find((row) => row.name === OTHER_MODELS);
	if (other) other.tokens += remainder;
	else kept.push({ name: OTHER_MODELS, tokens: remainder });
	return kept;
};

const addTo = (map: Map<string, number>, key: string, tokens: number) =>
	map.set(key, (map.get(key) ?? 0) + tokens);

interface UsageProfileRecord extends UsageTokenCounts {
	readonly model: string;
	readonly sessionId: string | null;
	readonly projectPath: string | null;
	readonly workspacePath: string | null;
	readonly startedAt: Date;
	readonly endedAt: Date;
	readonly provenance: string;
}

/**
 * Allowlisted projection of a UTC year-to-date report. Only aggregate counts
 * leave this function; paths and session identifiers are reduced to counts.
 */
export const usageProfileSnapshot = (
	report: {
		readonly generatedAt: Date;
		readonly summary: UsageTokenCounts & {
			readonly costUsd: number | null;
			readonly costStatus: "known" | "partial" | "unknown";
		};
		readonly groups: ReadonlyArray<UsageTokenCounts & { readonly key: string }>;
		readonly bySource: ReadonlyArray<
			UsageTokenCounts & { readonly key: string; readonly label: string }
		>;
		readonly records: ReadonlyArray<UsageProfileRecord>;
	},
	year: number,
	timeZone: string,
): UsageProfileSnapshot => {
	const models = new Map<string, number>();
	const months = new Map<number, Map<string, number>>();
	const projects = new Set<string>();
	const sessions = new Map<string, { start: number; end: number }>();
	const hours = Array.from({ length: 24 }, () => 0);
	const hourOf = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hour: "numeric",
		hourCycle: "h23",
	});
	for (const record of report.records) {
		const tokens = totalUsageTokens(record);
		addTo(models, record.model, tokens);
		const month = record.startedAt.getUTCMonth() + 1;
		const mix = months.get(month) ?? new Map<string, number>();
		months.set(month, addTo(mix, record.model, tokens));
		const project = record.projectPath ?? record.workspacePath;
		if (project) projects.add(project);
		if (record.provenance === PERSISTED_DAILY) continue;
		const hour = Number(hourOf.format(record.startedAt)) % 24;
		hours[hour] = (hours[hour] ?? 0) + tokens;
		if (record.sessionId === null) continue;
		const span = sessions.get(record.sessionId);
		const start = record.startedAt.getTime();
		const end = Math.max(start, record.endedAt.getTime());
		sessions.set(
			record.sessionId,
			span
				? { start: Math.min(span.start, start), end: Math.max(span.end, end) }
				: { start, end },
		);
	}
	const minutes = [...sessions.values()]
		.map((span) => Math.round((span.end - span.start) / 60_000))
		.sort((a, b) => a - b);
	const { summary } = report;
	return {
		year,
		generatedAt: report.generatedAt.toISOString(),
		// Distinct real sessions; rows without a session id are not sessions.
		sessionCount: sessions.size,
		days: report.groups
			.map((row) => ({ date: row.key, tokens: totalUsageTokens(row) }))
			.sort((a, b) => a.date.localeCompare(b.date)),
		models: rankShares(models, MAX_MODELS),
		breakdown: {
			input: summary.inputTokens,
			output: summary.outputTokens,
			cacheRead: summary.cacheReadTokens,
			cacheWrite: summary.cacheCreationTokens,
			reasoning: summary.reasoningTokens,
		},
		sources: report.bySource
			.map((row) => ({
				id: row.key,
				label: row.label,
				tokens: totalUsageTokens(row),
			}))
			.filter((row) => row.tokens > 0)
			.sort((a, b) => b.tokens - a.tokens),
		months: [...months]
			.sort(([a], [b]) => a - b)
			.map(([month, mix]) => ({
				month,
				models: rankShares(mix, MAX_MONTH_MODELS),
			}))
			.filter((row) => row.models.length > 0),
		projectCount: projects.size,
		sessionMinutes: {
			median: minutes[Math.floor((minutes.length - 1) / 2)] ?? 0,
			longest: minutes.at(-1) ?? 0,
		},
		cost:
			summary.costUsd === null ||
			summary.costStatus === "unknown" ||
			!Number.isFinite(summary.costUsd)
				? null
				: {
						usd: Math.round(summary.costUsd * 100) / 100,
						complete: summary.costStatus === "known",
					},
		hours,
	};
};

const sum = (values: Iterable<number>) => {
	let total = 0;
	for (const value of values) total += value;
	return total;
};

const validShares = (shares: ReadonlyArray<UsageProfileTokenShare>) => {
	const names = new Set<string>();
	for (const share of shares) {
		if (!share.name.trim() || names.has(share.name)) return false;
		names.add(share.name);
	}
	return true;
};

/** Validate the calendar and coverage as well as the numeric schema at the API boundary. */
export const validUsageProfileSnapshot = (
	snapshot: UsageProfileSnapshot,
	now = Date.now(),
): boolean => {
	const generated = new Date(snapshot.generatedAt);
	if (
		!Number.isFinite(generated.getTime()) ||
		generated.toISOString() !== snapshot.generatedAt ||
		generated.getTime() > now + 60_000 ||
		generated.getUTCFullYear() !== snapshot.year
	)
		return false;
	const through = snapshot.generatedAt.slice(0, 10);
	const dates = new Set<string>();
	let dayTotal = 0;
	for (const day of snapshot.days) {
		if (
			!/^\d{4}-\d{2}-\d{2}$/u.test(day.date) ||
			!day.date.startsWith(`${snapshot.year}-`) ||
			day.date > through ||
			dates.has(day.date)
		)
			return false;
		const date = new Date(`${day.date}T00:00:00.000Z`);
		if (
			!Number.isFinite(date.getTime()) ||
			date.toISOString().slice(0, 10) !== day.date
		)
			return false;
		dates.add(day.date);
		dayTotal += day.tokens;
	}
	if (!validShares(snapshot.models)) return false;
	const monthTotals = new Map<number, number>();
	for (const day of snapshot.days) {
		const month = Number(day.date.slice(5, 7));
		monthTotals.set(month, (monthTotals.get(month) ?? 0) + day.tokens);
	}
	const months = new Set<number>();
	for (const row of snapshot.months) {
		if (
			months.has(row.month) ||
			!validShares(row.models) ||
			sum(row.models.map((model) => model.tokens)) !==
				(monthTotals.get(row.month) ?? 0)
		)
			return false;
		months.add(row.month);
	}
	const monthTotal = sum(
		[...monthTotals].filter(([month]) => months.has(month)).map(([, n]) => n),
	);
	const sourceIds = new Set(snapshot.sources.map((source) => source.id));
	const { median, longest } = snapshot.sessionMinutes;
	return (
		Number.isSafeInteger(dayTotal) &&
		sum(snapshot.models.map((model) => model.tokens)) === dayTotal &&
		sum(Object.values(snapshot.breakdown)) === dayTotal &&
		sourceIds.size === snapshot.sources.length &&
		sum(snapshot.sources.map((source) => source.tokens)) === dayTotal &&
		monthTotal === dayTotal &&
		median <= longest &&
		(snapshot.hours === null ||
			(snapshot.hours.length === 24 && sum(snapshot.hours) <= dayTotal))
	);
};

export const usageProfileActivity = (snapshot: UsageProfileSnapshot) => {
	const counts = new Map(snapshot.days.map((day) => [day.date, day.tokens]));
	const end = Date.parse(`${snapshot.year + 1}-01-01T00:00:00.000Z`);
	const through = snapshot.generatedAt.slice(0, 10);
	const days: { date: string; tokens: number; covered: boolean }[] = [];
	let totalTokens = 0;
	let activeDays = 0;
	let run = 0;
	let longestStreak = 0;
	const activeWeeks = new Set<number>();
	const offset = new Date(Date.UTC(snapshot.year, 0, 1)).getUTCDay();
	for (
		let timestamp = Date.UTC(snapshot.year, 0, 1);
		timestamp < end;
		timestamp += 86_400_000
	) {
		const date = new Date(timestamp).toISOString().slice(0, 10);
		const count = counts.get(date) ?? 0;
		days.push({ date, tokens: count, covered: date <= through });
		totalTokens += count;
		if (count > 0 && date <= through) {
			activeDays += 1;
			run += 1;
			longestStreak = Math.max(longestStreak, run);
			activeWeeks.add(Math.floor((days.length - 1 + offset) / 7));
		} else run = 0;
	}
	const covered = days.filter((day) => day.covered);
	// An unfinished day does not break a streak until the following midnight UTC.
	let index = covered.length - 1;
	if (covered[index]?.tokens === 0) index -= 1;
	let currentStreak = 0;
	while (index >= 0 && (covered[index]?.tokens ?? 0) > 0) {
		currentStreak += 1;
		index -= 1;
	}
	return {
		days,
		offset,
		totalTokens,
		activeDays,
		longestStreak,
		currentStreak,
		activeWeeks: activeWeeks.size,
	};
};
