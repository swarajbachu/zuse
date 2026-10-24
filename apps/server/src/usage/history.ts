import { createHmac } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { type PricedUsage, SOURCE_LABELS, type UsageRecord } from "tokenmaxer";

/**
 * Durable usage history. Source tools rotate their logs (Claude Code keeps
 * about 30 days), so the server keeps hourly aggregates keyed by source,
 * model, session, and project. Live records always win unless the stored row
 * is larger, which means its log was trimmed. Rows from the legacy daily
 * table fill only days that have no hourly history.
 */

type Tokens = {
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
	reasoning_tokens: number;
};
export type DailyCostRow = Tokens & {
	day: string;
	source_id: UsageRecord["sourceId"];
	model: string;
	cost_usd: number | null;
	cost_status: "known" | "unknown";
	record_count: number;
};
/** `session` and `project` are raw ids locally and keyed hashes for backup rows. */
export type HistoryRow = Tokens & {
	hour: string;
	source_id: UsageRecord["sourceId"];
	model: string;
	session: string;
	project: string;
	cost_usd: number | null;
	record_count: number;
	first_at: number;
	last_at: number;
};

export const PERSISTED_DAILY = "persisted-daily";
export const PERSISTED_HISTORY = "persisted-history";
export const REMOTE_HISTORY = "remote-history";

const HOUR_MS = 3_600_000;
export const hourOf = (date: Date) =>
	new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS).toISOString();
const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const join = (...parts: string[]) => parts.join("\0");
const projectOf = (record: UsageRecord) =>
	record.projectPath ?? record.workspacePath ?? "";
const totalOf = (row: Tokens) =>
	row.input_tokens +
	row.output_tokens +
	row.cache_read_tokens +
	row.cache_creation_tokens +
	row.reasoning_tokens;
const recordTotal = (record: UsageRecord) =>
	record.inputTokens +
	record.outputTokens +
	record.cacheReadTokens +
	record.cacheCreationTokens +
	record.reasoningTokens;

/** 128-bit keyed hash; empty ids stay empty so "no session" still matches. */
export const opaqueKey = (secret: string, value: string) =>
	value
		? createHmac("sha256", Buffer.from(secret, "hex"))
				.update(value)
				.digest("hex")
				.slice(0, 32)
		: "";

export const historyRowKey = (row: HistoryRow) =>
	join(row.hour, row.source_id, row.model, row.session, row.project);
const localKey = (record: UsageRecord) =>
	join(
		hourOf(record.startedAt),
		record.sourceId,
		record.model,
		record.sessionId ?? "",
		projectOf(record),
	);
/** Aggregates live records into hourly rows with raw session and project ids. */
export const toHistoryRows = (
	records: ReadonlyArray<UsageRecord>,
): HistoryRow[] => {
	const rows = new Map<string, HistoryRow>();
	for (const record of records) {
		if (record.provenance.startsWith("persisted-")) continue;
		const key = localKey(record);
		const current = rows.get(key);
		const started = record.startedAt.getTime();
		const ended = Math.max(started, record.endedAt.getTime());
		rows.set(key, {
			hour: hourOf(record.startedAt),
			source_id: record.sourceId,
			model: record.model,
			session: record.sessionId ?? "",
			project: projectOf(record),
			input_tokens: (current?.input_tokens ?? 0) + record.inputTokens,
			output_tokens: (current?.output_tokens ?? 0) + record.outputTokens,
			cache_read_tokens:
				(current?.cache_read_tokens ?? 0) + record.cacheReadTokens,
			cache_creation_tokens:
				(current?.cache_creation_tokens ?? 0) + record.cacheCreationTokens,
			reasoning_tokens:
				(current?.reasoning_tokens ?? 0) + record.reasoningTokens,
			cost_usd:
				record.costUsd === null
					? (current?.cost_usd ?? null)
					: (current?.cost_usd ?? 0) + record.costUsd,
			record_count: (current?.record_count ?? 0) + 1,
			first_at: Math.min(current?.first_at ?? started, started),
			last_at: Math.max(current?.last_at ?? ended, ended),
		});
	}
	return [...rows.values()];
};

const historyRecord = (
	row: HistoryRow,
	provenance: string,
	ids: { sessionId: string | null; projectPath: string | null },
): UsageRecord => {
	const key = `${provenance}:${historyRowKey(row).replaceAll("\0", ":")}`;
	return {
		id: key,
		sourceId: row.source_id,
		sourceLabel: SOURCE_LABELS[row.source_id] ?? row.source_id,
		providerId: row.source_id,
		model: row.model,
		sessionId: ids.sessionId,
		projectPath: ids.projectPath,
		workspacePath: null,
		startedAt: new Date(row.first_at),
		endedAt: new Date(row.last_at),
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
		cacheReadTokens: row.cache_read_tokens,
		cacheCreationTokens: row.cache_creation_tokens,
		reasoningTokens: row.reasoning_tokens,
		costUsd: row.cost_usd,
		costStatus: row.cost_usd === null ? "unknown" : "known",
		loggedCostUsd: row.cost_usd,
		fast: false,
		provenance,
		confidence: "exact",
		fingerprint: key,
		possibleDuplicate: false,
	};
};

/**
 * Per key, keep whichever side counted more tokens: live records, or one
 * stored row standing in for logs that have since been trimmed.
 */
const mergeLargest = (
	records: ReadonlyArray<UsageRecord>,
	rows: ReadonlyArray<HistoryRow>,
	keyOf: (record: UsageRecord) => string,
	toRecord: (row: HistoryRow) => UsageRecord,
): UsageRecord[] => {
	const live = new Map<string, number>();
	for (const record of records) {
		const key = keyOf(record);
		live.set(key, (live.get(key) ?? 0) + recordTotal(record));
	}
	const replaced = new Set<string>();
	const added: UsageRecord[] = [];
	for (const row of rows) {
		const key = historyRowKey(row);
		const current = live.get(key);
		if (current !== undefined && current >= totalOf(row)) continue;
		if (current !== undefined) replaced.add(key);
		added.push(toRecord(row));
	}
	return [
		...records.filter((record) => !replaced.has(keyOf(record))),
		...added,
	];
};

const dailyRecord = (row: DailyCostRow): UsageRecord => ({
	...historyRecord(
		{
			...row,
			hour: `${row.day}T00:00:00.000Z`,
			session: "",
			project: "",
			first_at: Date.parse(`${row.day}T00:00:00.000Z`),
			last_at: Date.parse(`${row.day}T23:59:59.999Z`),
		},
		PERSISTED_DAILY,
		{ sessionId: null, projectPath: null },
	),
	costStatus: row.cost_status,
	confidence: "estimated",
});

export const mergePersistedUsage = (
	priced: PricedUsage,
	history: ReadonlyArray<HistoryRow>,
	daily: ReadonlyArray<DailyCostRow>,
): PricedUsage => {
	const records = mergeLargest(priced.records, history, localKey, (row) =>
		historyRecord(row, PERSISTED_HISTORY, {
			sessionId: row.session || null,
			projectPath: row.project || null,
		}),
	);
	const covered = new Set(
		records.map((record) =>
			join(dayOf(record.startedAt), record.sourceId, record.model),
		),
	);
	for (const row of daily)
		if (!covered.has(join(row.day, row.source_id, row.model)))
			records.push(dailyRecord(row));
	return { ...priced, records };
};

/** Replaces session and project ids with the account's keyed hashes. */
export const withHashedIds =
	(secret: string) =>
	(record: UsageRecord): UsageRecord => ({
		...record,
		sessionId: record.sessionId ? opaqueKey(secret, record.sessionId) : null,
		projectPath: opaqueKey(secret, projectOf(record)) || null,
		workspacePath: null,
	});

/**
 * Adds backup rows from other devices. Local records are re-keyed to the same
 * hashed ids first, so one session or project has one identity on both sides
 * and is never counted twice.
 */
export const mergeRemoteHistory = (
	records: ReadonlyArray<UsageRecord>,
	rows: ReadonlyArray<HistoryRow>,
	secret: string,
): UsageRecord[] =>
	mergeLargest(records.map(withHashedIds(secret)), rows, localKey, (row) =>
		historyRecord(row, REMOTE_HISTORY, {
			sessionId: row.session || null,
			projectPath: row.project || null,
		}),
	);

let persistedPricedValue: PricedUsage | null = null;

export const resetPersistedPricedUsageForTest = (): void => {
	persistedPricedValue = null;
};

export const persistPricedUsageOnce = <E, R>(
	priced: PricedUsage,
	persist: (value: PricedUsage) => Effect.Effect<void, E, R>,
) =>
	Effect.gen(function* () {
		if (persistedPricedValue === priced) return false;
		yield* persist(priced);
		persistedPricedValue = priced;
		return true;
	});

/**
 * Monotonic upsert. Rows that grow get the next `change_seq`, a database
 * counter rather than wall-clock time, so incremental backup never skips a row
 * when the system clock moves backward.
 */
export const persistUsageHistory = (priced: PricedUsage) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const rows = toHistoryRows(priced.records);
		yield* sql.withTransaction(
			Effect.gen(function* () {
				const [latest] = yield* sql<{
					seq: number;
				}>`SELECT COALESCE(MAX(change_seq), 0) AS seq FROM usage_history`;
				const seq = (latest?.seq ?? 0) + 1;
				yield* Effect.forEach(
					rows,
					(row) =>
						sql`INSERT INTO usage_history(hour, source_id, model, session_id, project_path, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens, cost_usd, record_count, first_at, last_at, change_seq) VALUES (${row.hour}, ${row.source_id}, ${row.model}, ${row.session}, ${row.project}, ${row.input_tokens}, ${row.output_tokens}, ${row.cache_read_tokens}, ${row.cache_creation_tokens}, ${row.reasoning_tokens}, ${row.cost_usd}, ${row.record_count}, ${row.first_at}, ${row.last_at}, ${seq}) ON CONFLICT(hour, source_id, model, session_id, project_path) DO UPDATE SET input_tokens=MAX(input_tokens,excluded.input_tokens), output_tokens=MAX(output_tokens,excluded.output_tokens), cache_read_tokens=MAX(cache_read_tokens,excluded.cache_read_tokens), cache_creation_tokens=MAX(cache_creation_tokens,excluded.cache_creation_tokens), reasoning_tokens=MAX(reasoning_tokens,excluded.reasoning_tokens), cost_usd=CASE WHEN cost_usd IS NULL THEN excluded.cost_usd WHEN excluded.cost_usd IS NULL THEN cost_usd ELSE MAX(cost_usd,excluded.cost_usd) END, record_count=MAX(record_count,excluded.record_count), first_at=MIN(first_at,excluded.first_at), last_at=MAX(last_at,excluded.last_at), change_seq=excluded.change_seq WHERE excluded.input_tokens>input_tokens OR excluded.output_tokens>output_tokens OR excluded.cache_read_tokens>cache_read_tokens OR excluded.cache_creation_tokens>cache_creation_tokens OR excluded.reasoning_tokens>reasoning_tokens OR excluded.record_count>record_count OR excluded.first_at<first_at OR excluded.last_at>last_at OR (cost_usd IS NULL AND excluded.cost_usd IS NOT NULL) OR excluded.cost_usd>cost_usd`,
					{ discard: true },
				);
			}),
		);
	});

const HISTORY_COLUMNS = (sql: SqlClient.SqlClient) =>
	sql`hour, source_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens, cost_usd, record_count, first_at, last_at`;

/** Rows changed after `sinceSeq`, oldest change first. */
export const readUsageHistory = (sinceSeq = -1) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		return yield* sql<
			HistoryRow & { change_seq: number }
		>`SELECT ${HISTORY_COLUMNS(sql)}, session_id AS session, project_path AS project, change_seq FROM usage_history WHERE change_seq > ${sinceSeq} ORDER BY change_seq`;
	});

export const readRemoteHistory = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	return yield* sql<HistoryRow>`SELECT ${HISTORY_COLUMNS(sql)}, session, project FROM usage_history_remote`;
});

export const readDailyHistory = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	return yield* sql<DailyCostRow>`SELECT day, source_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens, cost_usd, cost_status, record_count FROM usage_cost_daily`;
});

export const loadAndMergePersistedUsage = (priced: PricedUsage) =>
	Effect.gen(function* () {
		const history = yield* readUsageHistory();
		const daily = yield* readDailyHistory;
		return mergePersistedUsage(priced, history, daily);
	});
