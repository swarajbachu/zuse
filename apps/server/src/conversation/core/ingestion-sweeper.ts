import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";

class IngestionLeaseRenewed extends Schema.TaggedErrorClass<IngestionLeaseRenewed>()(
	"IngestionLeaseRenewed",
	{},
) {}
interface ExpiredLease {
	session_id: string;
	turn_id: string;
	attempt_id: string;
	provider_session_id: string;
	owner_id: string;
}

/**
 * Only sweep deadlines already reached on the previous pass. After a process
 * pause, heartbeats and this sweeper become runnable together; wall-clock expiry
 * alone must not let the sweeper kill every otherwise healthy consumer first.
 * An unresponsive consumer is still collected on the following pass.
 */
export const makeIngestionLeaseSweep = (
	sql: SqlClient.SqlClient,
	domain: SessionDomainApi,
	now: () => number = Date.now,
) => {
	let previousPassAt = now();
	return Effect.suspend(() => {
		const current = now();
		const cutoff = Math.min(previousPassAt, current);
		previousPassAt = current;
		return sweepIngestionLeases(sql, domain, current, cutoff);
	});
};

/** A bounded pass; revalidate expiry inside the command transaction before publishing anything. */
export const sweepIngestionLeases = (
	sql: SqlClient.SqlClient,
	domain: SessionDomainApi,
	now = Date.now(),
	expiredBefore = now,
) =>
	Effect.gen(function* () {
		const rows =
			yield* sql<ExpiredLease>`SELECT session_id, turn_id, attempt_id, provider_session_id, owner_id
		FROM session_ingestion_leases WHERE expires_at <= ${expiredBefore} ORDER BY expires_at, session_id LIMIT 100`.pipe(
				Effect.orDie,
			);
		yield* Effect.forEach(
			rows,
			(row) =>
				Effect.gen(function* () {
					const discard =
						sql`DELETE FROM session_ingestion_leases WHERE session_id = ${row.session_id} AND owner_id = ${row.owner_id} AND expires_at <= ${expiredBefore}`.pipe(
							Effect.asVoid,
							Effect.orDie,
						);
					yield* domain
						.dispatchTransactionally(
							{
								commandId: `ingestion-expired:${row.owner_id}`,
								streamId: row.session_id,
								expectedAttempt: {
									turnId: row.turn_id,
									attemptId: row.attempt_id,
								},
								expectedProviderSessionId: row.provider_session_id,
								command: {
									_tag: "ExpireAttempt",
									turnId: row.turn_id,
									expectedAttemptId: row.attempt_id,
									expiredAt: now,
								},
							},
							() =>
								Effect.gen(function* () {
									const removed =
										yield* sql`DELETE FROM session_ingestion_leases WHERE session_id = ${row.session_id} AND owner_id = ${row.owner_id} AND expires_at <= ${expiredBefore} RETURNING owner_id`;
									if (removed.length !== 1)
										return yield* new IngestionLeaseRenewed({});
								}),
						)
						.pipe(
							Effect.catchTag("IngestionLeaseRenewed", () => Effect.void),
							Effect.catchTag(
								[
									"AttemptOwnershipConflict",
									"ProviderSessionOwnershipConflict",
								],
								() => discard,
							),
							Effect.orDie,
						);
				}).pipe(
					Effect.timeout("5 seconds"),
					Effect.catchCause(() =>
						Effect.logWarning(
							"[ConversationServices] ingestion lease recovery deferred",
							{ sessionId: row.session_id },
						),
					),
				),
			{ concurrency: 8, discard: true },
		);
	});
