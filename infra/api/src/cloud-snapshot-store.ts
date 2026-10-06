import { Context, Effect } from "effect";
import { type SqlClient, SqlError } from "effect/unstable/sql";

export const SNAPSHOT_RATE_VERSION = "boat-snapshot-2026-10-v1";
export const SNAPSHOT_MONTH_MS = 30 * 24 * 60 * 60 * 1_000;
export const SNAPSHOT_MONTH_MICROS = 1_700_000;
export const SNAPSHOT_SETTLEMENT_INTERVAL_MS = 60 * 60_000;
export const SNAPSHOT_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;

/** Propagates the lease token so short writes can reject a resumed stale worker. */
export const SnapshotLifecycleLease = Context.Reference<
	{ accountId: string; owner: string } | undefined
>("SnapshotLifecycleLease", { defaultValue: () => undefined });

const checkLeasePg = (sql: SqlClient.SqlClient, accountId: string) =>
	Effect.gen(function* () {
		const lease = yield* SnapshotLifecycleLease;
		if (lease === undefined) return;
		if (lease.accountId !== accountId)
			return yield* Effect.die(new Error("snapshot lease account mismatch"));
		const rows =
			yield* sql`SELECT owner FROM api_cloud_snapshot_leases WHERE account_id=${accountId} AND owner=${lease.owner} AND expires_at > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint FOR UPDATE`;
		if (rows.length !== 1)
			return yield* Effect.die(new Error("snapshot lifecycle lease lost"));
	});

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
	readonly claimLease: (
		accountId: string,
		owner: string,
		ttlMs: number,
	) => Effect.Effect<boolean>;
	readonly renewLease: (
		accountId: string,
		owner: string,
		ttlMs: number,
	) => Effect.Effect<boolean>;
	readonly releaseLease: (
		accountId: string,
		owner: string,
	) => Effect.Effect<void>;
	readonly list: (
		accountId?: string,
		includeDeleted?: boolean,
		includeUnsettledDeleted?: boolean,
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
	claimLease: (accountId, owner, ttlMs) =>
		Effect.gen(function* () {
			yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`snapshot:${accountId}`}, 0))`;
			const rows =
				yield* sql`INSERT INTO api_cloud_snapshot_leases(account_id, owner, expires_at) VALUES (${accountId}, ${owner}, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + ${ttlMs}) ON CONFLICT(account_id) DO UPDATE SET owner=EXCLUDED.owner, expires_at=EXCLUDED.expires_at WHERE api_cloud_snapshot_leases.expires_at <= floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint RETURNING owner`;
			return rows.length === 1;
		}).pipe(sql.withTransaction, Effect.orDie),
	renewLease: (accountId, owner, ttlMs) =>
		sql`UPDATE api_cloud_snapshot_leases SET expires_at=floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + ${ttlMs} WHERE account_id=${accountId} AND owner=${owner} AND expires_at > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint RETURNING owner`.pipe(
			Effect.map((rows) => rows.length === 1),
			Effect.orDie,
		),
	releaseLease: (accountId, owner) =>
		sql`DELETE FROM api_cloud_snapshot_leases WHERE account_id=${accountId} AND owner=${owner}`.pipe(
			Effect.asVoid,
			Effect.orDie,
		),
	get: (accountId, snapshotId) =>
		sql<{
			readonly record: CloudSnapshotRecord;
		}>`SELECT record FROM api_cloud_snapshots WHERE provider='box' AND account_id=${accountId} AND snapshot_id=${snapshotId}`.pipe(
			Effect.map((rows) => rows[0]?.record ?? null),
			Effect.orDie,
		),
	list: (
		accountId,
		includeDeleted = accountId !== undefined,
		includeUnsettledDeleted = false,
	) =>
		sql<{
			readonly record: CloudSnapshotRecord;
		}>`SELECT record FROM api_cloud_snapshots WHERE (${accountId ?? null}::text IS NULL OR account_id = ${accountId ?? null}) AND (${includeDeleted} OR state != 'deleted' OR (${includeUnsettledDeleted} AND state = 'deleted' AND (record->>'retainedAtMs')::bigint IS NOT NULL AND COALESCE((record->>'checkpointAtMs')::bigint, (record->>'retainedAtMs')::bigint) < (record->>'stoppedAtMs')::bigint)) ORDER BY created_at, snapshot_id`.pipe(
			Effect.map((rows) => rows.map((row) => row.record)),
			Effect.orDie,
		),
	save: (record) =>
		Effect.gen(function* () {
			yield* checkLeasePg(sql, record.accountId);
			return yield* sql`INSERT INTO api_cloud_snapshots (provider, snapshot_id, account_id, build_id, state, created_at, record) VALUES (${record.provider}, ${record.snapshotId}, ${record.accountId}, ${record.buildId}, ${record.state}, ${record.createdAtMs}, ${JSON.stringify(record)}::jsonb) ON CONFLICT (provider, snapshot_id) DO UPDATE SET state = EXCLUDED.state, record = EXCLUDED.record WHERE api_cloud_snapshots.account_id = EXCLUDED.account_id AND api_cloud_snapshots.build_id = EXCLUDED.build_id RETURNING snapshot_id`;
		}).pipe(
			sql.withTransaction,
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
			yield* checkLeasePg(sql, accountId);
			return yield* effect;
		}).pipe(
			sql.withTransaction,
			Effect.catchIf(SqlError.isSqlError, Effect.die),
		),
});

export const makeCloudSnapshotStoreMemory = (): CloudSnapshotStoreApi => {
	const records = new Map<string, CloudSnapshotRecord>();
	const leases = new Map<string, { owner: string; expiresAt: number }>();
	const checkLease = (accountId: string) =>
		Effect.gen(function* () {
			const token = yield* SnapshotLifecycleLease;
			if (token === undefined) return;
			const lease = leases.get(accountId);
			if (
				token.accountId !== accountId ||
				lease?.owner !== token.owner ||
				lease.expiresAt <= Date.now()
			)
				return yield* Effect.die(new Error("snapshot lifecycle lease lost"));
		});
	return {
		claimLease: (accountId, owner, ttlMs) =>
			Effect.sync(() => {
				if ((leases.get(accountId)?.expiresAt ?? 0) > Date.now()) return false;
				leases.set(accountId, { owner, expiresAt: Date.now() + ttlMs });
				return true;
			}),
		renewLease: (accountId, owner, ttlMs) =>
			Effect.sync(() => {
				const lease = leases.get(accountId);
				if (lease?.owner !== owner || lease.expiresAt <= Date.now())
					return false;
				leases.set(accountId, { owner, expiresAt: Date.now() + ttlMs });
				return true;
			}),
		releaseLease: (accountId, owner) =>
			Effect.sync(() => {
				if (leases.get(accountId)?.owner === owner) leases.delete(accountId);
			}),
		get: (accountId, snapshotId) =>
			Effect.sync(() => {
				const record = records.get(snapshotId);
				return record?.accountId === accountId ? { ...record } : null;
			}),
		list: (
			accountId,
			includeDeleted = accountId !== undefined,
			includeUnsettledDeleted = false,
		) =>
			Effect.sync(() =>
				[...records.values()]
					.filter(
						(r) =>
							(accountId === undefined || r.accountId === accountId) &&
							(includeDeleted ||
								r.state !== "deleted" ||
								(includeUnsettledDeleted &&
									r.retainedAtMs !== undefined &&
									r.stoppedAtMs !== undefined &&
									(r.checkpointAtMs ?? r.retainedAtMs) < r.stoppedAtMs)),
					)
					.map((r) => ({ ...r })),
			),
		save: (record) =>
			checkLease(record.accountId).pipe(
				Effect.andThen(
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
				),
			),
		price: () => Effect.succeed(SNAPSHOT_MONTH_MICROS),
		transaction: (accountId, effect) =>
			checkLease(accountId).pipe(Effect.andThen(effect)),
	};
};
