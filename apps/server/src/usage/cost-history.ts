import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { PricedUsage } from "tokenmaxer";

type Record = PricedUsage["records"][number];
export type DailyCostRow = {
	day: string;
	source_id: Record["sourceId"];
	model: string;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
	reasoning_tokens: number;
	cost_usd: number | null;
	cost_status: "known" | "unknown";
	record_count: number;
};
const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const keyOf = (day: string, sourceId: string, model: string) =>
	`${day}\0${sourceId}\0${model}`;

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

export const persistDailyAggregates = (priced: PricedUsage) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const groups = new Map<string, DailyCostRow>();
		for (const record of priced.records) {
			const day = dayOf(record.startedAt);
			const key = keyOf(day, record.sourceId, record.model);
			const current = groups.get(key);
			groups.set(key, {
				day,
				source_id: record.sourceId,
				model: record.model,
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
				cost_status:
					record.costStatus === "unknown" || current?.cost_status === "unknown"
						? "unknown"
						: "known",
				record_count: (current?.record_count ?? 0) + 1,
			});
		}
		for (const row of groups.values())
			yield* sql`INSERT INTO usage_cost_daily(day, source_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens, cost_usd, cost_status, record_count, updated_at) VALUES (${row.day}, ${row.source_id}, ${row.model}, ${row.input_tokens}, ${row.output_tokens}, ${row.cache_read_tokens}, ${row.cache_creation_tokens}, ${row.reasoning_tokens}, ${row.cost_usd}, ${row.cost_status}, ${row.record_count}, ${new Date().toISOString()}) ON CONFLICT(day, source_id, model) DO UPDATE SET input_tokens=MAX(input_tokens,excluded.input_tokens), output_tokens=MAX(output_tokens,excluded.output_tokens), cache_read_tokens=MAX(cache_read_tokens,excluded.cache_read_tokens), cache_creation_tokens=MAX(cache_creation_tokens,excluded.cache_creation_tokens), reasoning_tokens=MAX(reasoning_tokens,excluded.reasoning_tokens), cost_usd=MAX(cost_usd,excluded.cost_usd), record_count=MAX(record_count,excluded.record_count), updated_at=excluded.updated_at`;
	});

export const mergePersistedDaily = (
	priced: PricedUsage,
	rows: readonly DailyCostRow[],
): PricedUsage => {
	const live = new Set(
		priced.records.map((record) =>
			keyOf(dayOf(record.startedAt), record.sourceId, record.model),
		),
	);
	const records = [...priced.records];
	for (const row of rows) {
		if (live.has(keyOf(row.day, row.source_id, row.model))) continue;
		const startedAt = new Date(`${row.day}T00:00:00.000Z`);
		records.push({
			id: `persisted:${row.day}:${row.source_id}:${row.model}`,
			sourceId: row.source_id,
			sourceLabel: row.source_id,
			providerId: row.source_id,
			model: row.model,
			sessionId: null,
			projectPath: null,
			workspacePath: null,
			startedAt,
			endedAt: new Date(`${row.day}T23:59:59.999Z`),
			inputTokens: row.input_tokens,
			outputTokens: row.output_tokens,
			cacheReadTokens: row.cache_read_tokens,
			cacheCreationTokens: row.cache_creation_tokens,
			reasoningTokens: row.reasoning_tokens,
			costUsd: row.cost_usd,
			costStatus: row.cost_status,
			loggedCostUsd: row.cost_usd,
			fast: false,
			provenance: "persisted-daily",
			confidence: "estimated",
			fingerprint: `persisted:${row.day}:${row.source_id}:${row.model}`,
			possibleDuplicate: false,
		});
	}
	return { ...priced, records };
};

export const loadAndMergePersistedDaily = (priced: PricedUsage) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const rows =
			yield* sql<DailyCostRow>`SELECT day, source_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens, cost_usd, cost_status, record_count FROM usage_cost_daily`;
		return mergePersistedDaily(priced, rows);
	});
