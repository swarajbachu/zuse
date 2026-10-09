import type { StripeBillingStore } from "@zuse/billing-providers/stripe";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";

/** Persists customer reservation generations and usage receipts without card data.
 * Customer retries renew only after remote absence is established; meter receipts never reset. */
export const makeStripeBillingStorePg = (
	sql: SqlClient.SqlClient,
): StripeBillingStore => {
	const run = <A>(effect: Effect.Effect<A, unknown>) =>
		Effect.runPromise(effect);
	/** Reads the winning reservation after insert or compare-and-swap renewal. */
	const readReservation = (accountId: string) =>
		Effect.gen(function* () {
			const rows = yield* sql<{
				customer_id: string | null;
				created_at: number;
				generation: number;
				recovery_cursor: string | null;
				recovery_matches: string[];
				recovery_complete: boolean;
			}>`SELECT customer_id, COALESCE(reservation_created_at, created_at) AS created_at, generation, recovery_cursor, recovery_matches, recovery_complete FROM api_stripe_customers WHERE account_id=${accountId}`;
			const row = rows[0];
			if (!row) throw new Error("stripe_customer_reservation_missing");
			return {
				customerId: row.customer_id ?? undefined,
				createdAtMs: Number(row.created_at),
				generation: Number(row.generation),
				recoveryCursor: row.recovery_cursor ?? undefined,
				recoveryMatches: row.recovery_matches,
				recoveryComplete: row.recovery_complete,
			};
		});
	return {
		claimCustomerRecoveries: (nowMs, limit) =>
			run(
				Effect.gen(function* () {
					const rows = yield* sql<{
						account_id: string;
					}>`WITH jobs AS (SELECT account_id FROM api_stripe_customers WHERE customer_id IS NULL AND NOT recovery_complete AND COALESCE(reservation_created_at, created_at) <= ${nowMs - 23 * 60 * 60_000} AND COALESCE(recovery_attempted_at, 0) <= ${nowMs - 5 * 60_000} ORDER BY COALESCE(recovery_attempted_at, 0), account_id FOR UPDATE SKIP LOCKED LIMIT ${limit}) UPDATE api_stripe_customers c SET recovery_attempted_at=${nowMs} FROM jobs WHERE c.account_id=jobs.account_id RETURNING c.account_id`;
					const jobs = [];
					for (const row of rows)
						jobs.push({
							accountId: row.account_id,
							...(yield* readReservation(row.account_id)),
						});
					return jobs;
				}).pipe(sql.withTransaction),
			),
		finishCustomerRecovery: (accountId, generation, cursor, page) =>
			run(
				Effect.gen(function* () {
					const current = yield* readReservation(accountId);
					if (
						current.generation !== generation ||
						current.recoveryCursor !== cursor ||
						current.recoveryComplete
					)
						return;
					const matches = [
						...new Set([...current.recoveryMatches, ...page.matches]),
					].slice(0, 2);
					yield* sql`UPDATE api_stripe_customers SET recovery_cursor=${page.nextCursor ?? null}, recovery_matches=${JSON.stringify(matches)}::jsonb, recovery_complete=${page.nextCursor === undefined || matches.length > 1} WHERE account_id=${accountId} AND customer_id IS NULL AND generation=${generation} AND NOT recovery_complete AND recovery_cursor IS NOT DISTINCT FROM ${cursor ?? null}`;
				}),
			),
		getCustomer: (accountId) =>
			run(
				sql<{
					customer_id: string | null;
				}>`SELECT customer_id FROM api_stripe_customers WHERE account_id=${accountId}`.pipe(
					Effect.map((rows) => rows[0]?.customer_id ?? null),
				),
			),
		reserveCustomer: (accountId) =>
			run(
				Effect.gen(function* () {
					yield* sql`INSERT INTO api_stripe_customers (account_id, created_at) VALUES (${accountId}, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint) ON CONFLICT DO NOTHING`;
					return yield* readReservation(accountId);
				}),
			),
		renewCustomerReservation: (accountId, generation) =>
			run(
				Effect.gen(function* () {
					yield* sql`UPDATE api_stripe_customers SET recovery_cursor=NULL, recovery_matches='[]'::jsonb, recovery_complete=FALSE, recovery_attempted_at=NULL, generation=generation+1, reservation_created_at=(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint WHERE account_id=${accountId} AND customer_id IS NULL AND generation=${generation} AND recovery_complete AND recovery_matches='[]'::jsonb`;
					return yield* readReservation(accountId);
				}).pipe(sql.withTransaction),
			),
		linkCustomer: (accountId, customerId) =>
			run(
				sql`UPDATE api_stripe_customers SET customer_id=${customerId} WHERE account_id=${accountId} AND (customer_id IS NULL OR customer_id=${customerId}) RETURNING account_id`.pipe(
					Effect.map((rows) => {
						if (rows.length !== 1)
							throw new Error("stripe_customer_binding_conflict");
						return undefined;
					}),
				),
			),
		claimDelivery: (key, payload) =>
			run(
				Effect.gen(function* () {
					const rows = yield* sql<{
						payload: string;
						sent_at: number | null;
						first_attempt_at: number;
						lease_until: number;
						now_ms: number;
					}>`INSERT INTO api_stripe_meter_deliveries (delivery_key, payload, first_attempt_at, lease_until)
			VALUES (${key}, ${payload}, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint, 0)
			ON CONFLICT (delivery_key) DO UPDATE SET delivery_key=EXCLUDED.delivery_key
			RETURNING payload, sent_at, first_attempt_at, lease_until, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms`;
					const row = rows[0];
					if (!row || row.payload !== payload)
						throw new Error("stripe_delivery_payload_conflict");
					if (row.sent_at !== null) return "sent" as const;
					if (
						Number(row.now_ms) - Number(row.first_attempt_at) >=
						23 * 60 * 60_000
					)
						return "expired" as const;
					if (Number(row.lease_until) > Number(row.now_ms))
						return "busy" as const;
					yield* sql`UPDATE api_stripe_meter_deliveries SET lease_until=${Number(row.now_ms) + 60_000} WHERE delivery_key=${key}`;
					return "send" as const;
				}).pipe(sql.withTransaction),
			),
		finishDelivery: (key, sent) =>
			run(
				sql`UPDATE api_stripe_meter_deliveries SET lease_until=0, sent_at=CASE WHEN ${sent} THEN (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint ELSE sent_at END WHERE delivery_key=${key}`.pipe(
					Effect.asVoid,
				),
			),
	};
};
