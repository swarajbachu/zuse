import { Effect } from "effect";
import { type SqlClient, SqlError } from "effect/unstable/sql";

export const SNAPSHOT_RATE_VERSION = "boat-snapshot-2026-10-v1";
export const SNAPSHOT_MONTH_MS = 30 * 24 * 60 * 60 * 1_000;
export const SNAPSHOT_MONTH_MICROS = 1_700_000;
export const SNAPSHOT_SETTLEMENT_INTERVAL_MS = 60 * 60_000;
export const SNAPSHOT_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;

export interface CloudSnapshotRecord {
	readonly snapshotId: string;
	readonly provider: "box";
	readonly accountId: string;
	readonly buildId: string;
	readonly state: "creating" | "retained" | "deleting" | "deleted";
	readonly createdAtMs: number;
	readonly retainedAtMs?: number;
	readonly stoppedAtMs?: number;
	readonly deletedAtMs?: number;
	readonly deletionReason?:
		| "superseded"
		| "user"
		| "expiry"
		| "account"
		| "missing"
		| "failed-build";
	readonly checkpointAtMs?: number;
	readonly remainder: number;
	readonly graceUntilMs?: number;
	readonly attempts: number;
	readonly nextAttemptAtMs: number;
	readonly lastError?: string;
}

/** Integer rational arithmetic; carry sub-micro-USD across checkpoints. */
export const snapshotStorageCost = (
	durationMs: number,
	remainder = 0,
	rateMicros = SNAPSHOT_MONTH_MICROS,
) => {
	if (
		!Number.isSafeInteger(durationMs) ||
		durationMs < 0 ||
		!Number.isSafeInteger(remainder) ||
		remainder < 0 ||
		remainder >= SNAPSHOT_MONTH_MS ||
		!Number.isSafeInteger(rateMicros) ||
		rateMicros < 0
	)
		throw new Error("invalid snapshot cost interval");
	const numerator = BigInt(durationMs) * BigInt(rateMicros) + BigInt(remainder);
	const micros = Number(numerator / BigInt(SNAPSHOT_MONTH_MS));
	if (!Number.isSafeInteger(micros))
		throw new Error("snapshot cost exceeds safe integer");
	return { micros, remainder: Number(numerator % BigInt(SNAPSHOT_MONTH_MS)) };
};

export interface CloudSnapshotStoreApi {
	readonly list: (
		accountId?: string,
		includeDeleted?: boolean,
	) => Effect.Effect<ReadonlyArray<CloudSnapshotRecord>>;
	readonly get: (
		accountId: string,
		snapshotId: string,
	) => Effect.Effect<CloudSnapshotRecord | null>;
	readonly save: (record: CloudSnapshotRecord) => Effect.Effect<void>;
	readonly price: () => Effect.Effect<number>;
	/** Serialize all billing and lifecycle changes for an account, including nested store calls. */
	readonly transaction: <A, E, R>(
		accountId: string,
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E, R>;
}

export const makeCloudSnapshotStorePg = (
	sql: SqlClient.SqlClient,
): CloudSnapshotStoreApi => ({
	get: (accountId, snapshotId) =>
		sql<{
			readonly record: CloudSnapshotRecord;
		}>`SELECT record FROM api_cloud_snapshots WHERE provider='box' AND account_id=${accountId} AND snapshot_id=${snapshotId}`.pipe(
			Effect.map((rows) => rows[0]?.record ?? null),
			Effect.orDie,
		),
	list: (accountId, includeDeleted = accountId !== undefined) =>
		sql<{
			readonly record: CloudSnapshotRecord;
		}>`SELECT record FROM api_cloud_snapshots WHERE (${accountId ?? null}::text IS NULL OR account_id = ${accountId ?? null}) AND (${includeDeleted} OR state != 'deleted') ORDER BY created_at, snapshot_id`.pipe(
			Effect.map((rows) => rows.map((row) => row.record)),
			Effect.orDie,
		),
	save: (record) =>
		sql`INSERT INTO api_cloud_snapshots (provider, snapshot_id, account_id, build_id, state, created_at, record) VALUES (${record.provider}, ${record.snapshotId}, ${record.accountId}, ${record.buildId}, ${record.state}, ${record.createdAtMs}, ${JSON.stringify(record)}::jsonb) ON CONFLICT (provider, snapshot_id) DO UPDATE SET state = EXCLUDED.state, record = EXCLUDED.record WHERE api_cloud_snapshots.account_id = EXCLUDED.account_id AND api_cloud_snapshots.build_id = EXCLUDED.build_id RETURNING snapshot_id`.pipe(
			Effect.flatMap((rows) =>
				rows.length === 1
					? Effect.void
					: Effect.die(new Error("snapshot ownership conflict")),
			),
			Effect.orDie,
		),
	price: () =>
		sql<{
			readonly monthly_micros: number;
		}>`SELECT monthly_micros FROM api_snapshot_price_schedule WHERE provider = 'box' AND version = ${SNAPSHOT_RATE_VERSION}`.pipe(
			Effect.map((rows) => {
				const rate = Number(rows[0]?.monthly_micros);
				if (rate !== SNAPSHOT_MONTH_MICROS)
					throw new Error("snapshot price schedule missing or changed");
				return rate;
			}),
			Effect.orDie,
		),
	transaction: (accountId, effect) =>
		Effect.gen(function* () {
			yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`snapshot:${accountId}`}, 0))`.pipe(
				Effect.orDie,
			);
			return yield* effect;
		}).pipe(
			sql.withTransaction,
			Effect.catchIf(SqlError.isSqlError, Effect.die),
		),
});

export const makeCloudSnapshotStoreMemory = (): CloudSnapshotStoreApi => {
	const records = new Map<string, CloudSnapshotRecord>();
	return {
		get: (accountId, snapshotId) =>
			Effect.sync(() => {
				const record = records.get(snapshotId);
				return record?.accountId === accountId ? { ...record } : null;
			}),
		list: (accountId, includeDeleted = accountId !== undefined) =>
			Effect.sync(() =>
				[...records.values()]
					.filter(
						(r) =>
							(accountId === undefined || r.accountId === accountId) &&
							(includeDeleted || r.state !== "deleted"),
					)
					.map((r) => ({ ...r })),
			),
		save: (record) =>
			Effect.sync(() => {
				const previous = records.get(record.snapshotId);
				if (
					previous &&
					(previous.accountId !== record.accountId ||
						previous.buildId !== record.buildId)
				)
					throw new Error("snapshot ownership conflict");
				records.set(record.snapshotId, { ...record });
			}),
		price: () => Effect.succeed(SNAPSHOT_MONTH_MICROS),
		transaction: (_accountId, effect) => effect,
	};
};
