import { addCounts, ZERO_TOKENS } from "./normalize.ts";
import type {
	TokenCounts,
	UsageBucket,
	UsageFilters,
	UsageGroup,
	UsageRecord,
	UsageReport,
	UsageSourceStatus,
	UsageSummary,
} from "./types.ts";

const cloneZero = (): TokenCounts => ({ ...ZERO_TOKENS });

const summarize = (records: ReadonlyArray<UsageRecord>): UsageSummary => {
	const counts = cloneZero();
	let costUsd = 0;
	let known = 0;
	let unknown = 0;
	let possibleDuplicateCount = 0;
	for (const record of records) {
		addCounts(counts, record);
		if (record.costUsd === null) unknown += 1;
		else {
			known += 1;
			costUsd += record.costUsd;
		}
		if (record.possibleDuplicate) possibleDuplicateCount += 1;
	}
	return {
		...counts,
		costUsd: known === 0 ? null : costUsd,
		costStatus: unknown === 0 ? "known" : known === 0 ? "unknown" : "partial",
		recordCount: records.length,
		possibleDuplicateCount,
	};
};

const pad2 = (n: number): string => n.toString().padStart(2, "0");

const dateParts = (
	date: Date,
	timezone: string,
): { year: number; month: number; day: number } => {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	const get = (type: string) =>
		Number(parts.find((p) => p.type === type)?.value ?? "0");
	return { year: get("year"), month: get("month"), day: get("day") };
};

const bucketKey = (
	record: UsageRecord,
	bucket: UsageBucket,
	timezone: string,
): string => {
	if (bucket === "session") {
		return record.sessionId ?? record.fingerprint;
	}
	const parts = dateParts(record.startedAt, timezone);
	if (bucket === "monthly") return `${parts.year}-${pad2(parts.month)}`;
	if (bucket === "weekly") {
		const utc = Date.UTC(parts.year, parts.month - 1, parts.day);
		const d = new Date(utc);
		const day = d.getUTCDay() || 7;
		d.setUTCDate(d.getUTCDate() + 4 - day);
		const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
		const week = Math.ceil(
			((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
		);
		return `${d.getUTCFullYear()}-W${pad2(week)}`;
	}
	return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
};

export const groupUsageRecords = (
	records: ReadonlyArray<UsageRecord>,
	keyFor: (record: UsageRecord) => string,
	labelFor: (record: UsageRecord, key: string) => string = (_record, key) =>
		key,
): ReadonlyArray<UsageGroup> => {
	const buckets = new Map<string, UsageRecord[]>();
	for (const record of records) {
		const key = keyFor(record);
		const list = buckets.get(key);
		if (list === undefined) buckets.set(key, [record]);
		else list.push(record);
	}
	return Array.from(buckets.entries())
		.map(([key, rows]) => {
			const sorted = rows
				.slice()
				.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
			return {
				key,
				label: labelFor(sorted[0]!, key),
				startedAt: sorted[0]?.startedAt ?? null,
				endedAt: sorted[sorted.length - 1]?.endedAt ?? null,
				sourceIds: Array.from(new Set(rows.map((r) => r.sourceId))).sort(),
				...summarize(rows),
			};
		})
		.sort((a, b) => {
			const aTime = a.startedAt?.getTime() ?? 0;
			const bTime = b.startedAt?.getTime() ?? 0;
			if (aTime !== bTime) return aTime - bTime;
			return a.label.localeCompare(b.label);
		});
};

/** A path matches a root when they are equal or one is a directory ancestor of the other. */
const matchesAnyRoot = (
	path: string | null,
	roots: ReadonlyArray<string>,
): boolean => {
	if (path === null) return false;
	return roots.some(
		(root) =>
			path === root ||
			path.startsWith(`${root}/`) ||
			root.startsWith(`${path}/`),
	);
};

export const filterUsageRecords = (
	records: ReadonlyArray<UsageRecord>,
	filters: UsageFilters,
): ReadonlyArray<UsageRecord> => {
	const sourceSet =
		filters.sourceIds === undefined || filters.sourceIds.length === 0
			? null
			: new Set(filters.sourceIds);
	const providerSet =
		filters.providerIds === undefined || filters.providerIds.length === 0
			? null
			: new Set(filters.providerIds);
	const roots =
		filters.projectPaths === undefined || filters.projectPaths.length === 0
			? null
			: filters.projectPaths;
	return records.filter((record) => {
		if (sourceSet !== null && !sourceSet.has(record.sourceId)) return false;
		if (providerSet !== null && !providerSet.has(record.providerId))
			return false;
		if (filters.since !== undefined && record.endedAt < filters.since)
			return false;
		if (filters.until !== undefined && record.startedAt > filters.until)
			return false;
		if (
			roots !== null &&
			!matchesAnyRoot(record.projectPath, roots) &&
			!matchesAnyRoot(record.workspacePath, roots)
		) {
			return false;
		}
		if (
			filters.includePossibleDuplicates !== true &&
			record.possibleDuplicate
		) {
			return false;
		}
		return true;
	});
};

export const buildUsageReport = (input: {
	records: ReadonlyArray<UsageRecord>;
	sources: ReadonlyArray<UsageSourceStatus>;
	bucket: UsageBucket;
	filters?: UsageFilters;
}): UsageReport => {
	const filters = { ...(input.filters ?? {}), bucket: input.bucket };
	const timezone =
		filters.timezone ??
		Intl.DateTimeFormat().resolvedOptions().timeZone ??
		"UTC";
	const records = filterUsageRecords(input.records, filters);
	return {
		bucket: input.bucket,
		generatedAt: new Date(),
		filters,
		summary: summarize(records),
		groups: groupUsageRecords(
			records,
			(record) => bucketKey(record, input.bucket, timezone),
			(record, key) =>
				input.bucket === "session"
					? (record.sessionId ?? `${record.sourceLabel} ${record.model}`)
					: key,
		),
		bySource: groupUsageRecords(
			records,
			(record) => record.sourceId,
			(record) => record.sourceLabel,
		),
		byModel: groupUsageRecords(records, (record) => record.model),
		bySession: groupUsageRecords(
			records,
			(record) => record.sessionId ?? record.fingerprint,
			(record) => record.sessionId ?? `${record.sourceLabel} ${record.model}`,
		),
		records,
		sources: input.sources,
	};
};
