import type { AttemptOwnership } from "@zuse/domain/engine/dispatch";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";

export interface IngestionLeaseIdentity extends AttemptOwnership {
	readonly providerSessionId: string;
}
export interface IngestionLease {
	readonly renew: (providerActivityAt?: number) => Effect.Effect<boolean>;
	/** Exact-owner deletion cannot remove a replacement subscription's lease. */
	readonly release: Effect.Effect<void>;
	readonly expire: Effect.Effect<void>;
}
export const INGESTION_HEARTBEAT_MS = 5_000;
export const INGESTION_LEASE_MS = 30_000;

/** A lease belongs to one consumer and one physical provider residency. */
export const acquireIngestionLease = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	identity: IngestionLeaseIdentity,
	options: { readonly now?: () => number; readonly leaseMs?: number } = {},
): Effect.Effect<IngestionLease | null> =>
	Effect.gen(function* () {
		const now = options.now ?? Date.now;
		const leaseMs = options.leaseMs ?? INGESTION_LEASE_MS;
		const ownerId = crypto.randomUUID();
		const startedAt = now();
		const inserted = yield* sql`INSERT INTO session_ingestion_leases
		(session_id, turn_id, attempt_id, provider_session_id, owner_id, heartbeat_at, provider_activity_at, expires_at)
		SELECT s.id, t.id, t.active_attempt_id, s.provider_reservation_id, ${ownerId}, ${startedAt}, NULL, ${startedAt + leaseMs}
		FROM sessions s JOIN session_turns t ON t.session_id = s.id
		WHERE s.id = ${sessionId} AND s.archived_at IS NULL AND s.provider_reservation_id = ${identity.providerSessionId}
		AND t.id = ${identity.turnId} AND t.active_attempt_id = ${identity.attemptId} AND t.status IN ('starting', 'running')
		ON CONFLICT(session_id) DO UPDATE SET turn_id = excluded.turn_id, attempt_id = excluded.attempt_id,
		provider_session_id = excluded.provider_session_id, owner_id = excluded.owner_id,
		heartbeat_at = excluded.heartbeat_at, provider_activity_at = NULL, expires_at = excluded.expires_at
		WHERE session_ingestion_leases.expires_at <= ${startedAt}
		OR session_ingestion_leases.provider_session_id <> excluded.provider_session_id
		OR session_ingestion_leases.attempt_id <> excluded.attempt_id
		RETURNING owner_id`.pipe(Effect.orDie);
		if (inserted.length === 0) return null;
		let retired = false;
		return {
			renew: (providerActivityAt) =>
				sql
					.withTransaction(
						Effect.gen(function* () {
							if (retired) return false;
							// Sample after acquiring SQL: database contention must not commit
							// a renewal whose deadline has already elapsed while waiting.
							const timestamp = now();
							// A delayed heartbeat may resume after its deadline. The exact
							// owner and graph checks fence it against takeover or recovery;
							// elapsed wall time alone does not prove the consumer died.
							const updated = yield* sql`UPDATE session_ingestion_leases
				SET heartbeat_at = ${timestamp}, expires_at = ${timestamp + leaseMs},
				provider_activity_at = COALESCE(${providerActivityAt ?? null}, provider_activity_at)
				WHERE session_id = ${sessionId} AND owner_id = ${ownerId}
				AND EXISTS (SELECT 1 FROM sessions s JOIN session_turns t ON t.session_id = s.id
					WHERE s.id = ${sessionId} AND s.archived_at IS NULL AND s.provider_reservation_id = ${identity.providerSessionId}
					AND t.id = ${identity.turnId} AND t.active_attempt_id = ${identity.attemptId} AND t.status IN ('starting', 'running'))
				RETURNING owner_id`.pipe(Effect.orDie);
							return updated.length === 1;
						}),
					)
					.pipe(Effect.orDie),
			expire: Effect.suspend(() => {
				retired = true;
				return sql`UPDATE session_ingestion_leases SET expires_at = MIN(expires_at, ${now()}) WHERE session_id = ${sessionId} AND owner_id = ${ownerId}`;
			}).pipe(Effect.asVoid, Effect.orDie),
			release: Effect.suspend(() => {
				retired = true;
				return sql`DELETE FROM session_ingestion_leases WHERE session_id = ${sessionId} AND owner_id = ${ownerId}`;
			}).pipe(Effect.asVoid, Effect.orDie),
		};
	});
