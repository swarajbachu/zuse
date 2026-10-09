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
			}>`SELECT customer_id, COALESCE(reservation_created_at, created_at) AS created_at, generation FROM api_stripe_customers WHERE account_id=${accountId}`;
			const row = rows[0];
			if (!row) throw new Error("stripe_customer_reservation_missing");
			return {
				customerId: row.customer_id ?? undefined,
				createdAtMs: Number(row.created_at),
				generation: Number(row.generation),
			};
		});
	return {
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
					yield* sql`UPDATE api_stripe_customers SET generation=generation+1, reservation_created_at=(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint WHERE account_id=${accountId} AND customer_id IS NULL AND generation=${generation}`;
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
