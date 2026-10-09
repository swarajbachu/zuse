import { readdir, readFile } from "node:fs/promises";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Client, Pool } from "pg";
import { expect, it } from "vitest";
import {
	CloudBillingStore,
	CloudBillingStorePg,
} from "../../src/cloud-billing-store.ts";
import { makeStripeBillingStorePg } from "../../src/stripe-billing-store.ts";

const connectionString = process.env.ZUSE_TEST_DATABASE_URL;
it.skipIf(!connectionString)(
	"preserves billing ownership, atomic exports and Stripe delivery receipts across concurrency and restart",
	async () => {
		const db = new Client({ connectionString });
		await db.connect();
		const schema = `stripe_${crypto.randomUUID().replaceAll("-", "")}`;
		await db.query(`CREATE SCHEMA ${schema}`);
		await db.query(`SET search_path=${schema}`);
		const dbLayer = PgClient.layerFrom(
			PgClient.fromPool({
				acquire: Effect.acquireRelease(
					Effect.sync(
						() =>
							new Pool({
								connectionString,
								options: `-c search_path=${schema}`,
							}),
					),
					(pool) => Effect.promise(() => pool.end()),
				),
			}),
		);
		let runtime = ManagedRuntime.make(
			Layer.merge(dbLayer, CloudBillingStorePg.pipe(Layer.provide(dbLayer))),
		);
		try {
			const directory = new URL("../../drizzle/migrations/", import.meta.url);
			for (const name of (await readdir(directory))
				.filter((name) => name.endsWith(".sql"))
				.sort()) {
				if (name === "0040_stripe_billing.sql") {
					await db.query(
						"INSERT INTO api_cloud_billing_periods (period_id,account_id,provider_subscription_id,status,currency,period_start,period_end,base_price_micros,included_provider_cost_micros,markup_basis_points,price_catalog_version,overage_cap_micros,created_at,updated_at) VALUES ('legacy','legacy','polar_sub','active','USD',0,100000,40000000,35000000,500,'v1',25000000,0,0)",
					);
					await db.query(
						"INSERT INTO api_cloud_billing_outbox (outbox_id,period_id,account_id,provider,amount_cents,idempotency_key,attempt_count,next_attempt_at,created_at) VALUES ('legacy','legacy','legacy','polar',10,'legacy',0,0,200000)",
					);
				}
				await db.query(
					(await readFile(new URL(name, directory), "utf8")).replaceAll(
						'"public".',
						`"${schema}".`,
					),
				);
			}
			expect(
				(
					await db.query(
						"SELECT billing_provider FROM api_cloud_billing_periods WHERE period_id='legacy'",
					)
				).rows[0],
			).toEqual({ billing_provider: "polar" });
			expect(
				Number(
					(
						await db.query(
							"SELECT occurred_at FROM api_cloud_billing_outbox WHERE outbox_id='legacy'",
						)
					).rows[0].occurred_at,
				),
			).toBe(99000);
			// A currently deployed Polar Worker still omits the new occurred_at
			// column. Database-first rollout must keep that writer working.
			const legacyInsertStartedAt = Date.now();
			const legacyWrite = await db.query(
				"INSERT INTO api_cloud_billing_outbox (outbox_id,period_id,account_id,provider,amount_cents,idempotency_key,attempt_count,next_attempt_at,created_at) VALUES ('old-worker','legacy','legacy','polar',1,'old-worker',0,0,$1) RETURNING occurred_at",
				[legacyInsertStartedAt],
			);
			expect(Number(legacyWrite.rows[0].occurred_at)).toBeGreaterThanOrEqual(
				legacyInsertStartedAt,
			);
			expect(Number(legacyWrite.rows[0].occurred_at)).toBeLessThanOrEqual(
				Date.now(),
			);
			const sql = await runtime.runPromise(SqlClient.SqlClient);
			let stripe = makeStripeBillingStorePg(sql);
			const reservations = await Promise.all(
				Array.from({ length: 8 }, () => stripe.reserveCustomer("account")),
			);
			expect(new Set(reservations.map((item) => item.createdAtMs)).size).toBe(
				1,
			);

			const renewal = await stripe.reserveCustomer("retry-account");
			expect(renewal.generation).toBe(0);
			await db.query(
				"UPDATE api_stripe_customers SET created_at=created_at-86400000 WHERE account_id='retry-account'",
			);
			const legacyReservation = await stripe.reserveCustomer("retry-account");
			const renewed = await Promise.all(
				Array.from({ length: 8 }, () =>
					stripe.renewCustomerReservation("retry-account", renewal.generation),
				),
			);
			expect(new Set(renewed.map((item) => item.generation))).toEqual(
				new Set([1]),
			);
			expect(new Set(renewed.map((item) => item.createdAtMs)).size).toBe(1);
			const oldWorkerRow = await db.query(
				"SELECT created_at FROM api_stripe_customers WHERE account_id='retry-account'",
			);
			expect(Number(oldWorkerRow.rows[0].created_at)).toBe(
				legacyReservation.createdAtMs,
			);
			expect(renewed[0]?.createdAtMs).toBeGreaterThan(
				legacyReservation.createdAtMs,
			);
			await stripe.linkCustomer("retry-account", "cus_retry");
			expect(await stripe.renewCustomerReservation("retry-account", 1)).toEqual(
				{ ...renewed[0], customerId: "cus_retry" },
			);
			await Promise.all(
				Array.from({ length: 8 }, () =>
					stripe.linkCustomer("account", "cus_account"),
				),
			);
			await expect(stripe.linkCustomer("account", "cus_wrong")).rejects.toThrow(
				"stripe_customer_binding_conflict",
			);
			expect(await stripe.getCustomer("account")).toBe("cus_account");
			const claims = await Promise.all(
				Array.from({ length: 8 }, () =>
					stripe.claimDelivery("delivery", "payload"),
				),
			);
			expect(claims.filter((claim) => claim === "send")).toHaveLength(1);
			expect(claims.filter((claim) => claim === "busy")).toHaveLength(7);
			await stripe.finishDelivery("delivery", true);
			await runtime.dispose();
			runtime = ManagedRuntime.make(
				Layer.merge(dbLayer, CloudBillingStorePg.pipe(Layer.provide(dbLayer))),
			);
			stripe = makeStripeBillingStorePg(
				await runtime.runPromise(SqlClient.SqlClient),
			);
			expect(await stripe.claimDelivery("delivery", "payload")).toBe("sent");
			await expect(
				stripe.claimDelivery("delivery", "different"),
			).rejects.toThrow("stripe_delivery_payload_conflict");
			expect(await stripe.claimDelivery("ambiguous", "payload")).toBe("send");
			await stripe.finishDelivery("ambiguous", false);
			await db.query(
				"UPDATE api_stripe_meter_deliveries SET first_attempt_at=first_attempt_at-86400000 WHERE delivery_key='ambiguous'",
			);
			expect(await stripe.claimDelivery("ambiguous", "payload")).toBe(
				"expired",
			);
			const store = await runtime.runPromise(CloudBillingStore);
			const now = Math.floor(Date.now() / 60000) * 60000;
			await runtime.runPromise(
				store.ensurePeriod({
					periodId: "prior-polar",
					accountId: "account",
					billingProvider: "polar",
					providerSubscriptionId: "sub_polar",
					status: "ended",
					periodStartMs: now - 200000,
					periodEndMs: now - 100000,
					overageCapMicros: 70000000,
					nowMs: now,
				}),
			);
			const period = await runtime.runPromise(
				store.ensurePeriod({
					periodId: "stripe-period",
					accountId: "account",
					billingProvider: "stripe",
					providerSubscriptionId: "sub_stripe",
					status: "active",
					periodStartMs: now - 100000,
					periodEndMs: now + 86400000,
					nowMs: now,
				}),
			);
			await expect(
				runtime.runPromise(
					store.ensurePeriod({
						...period,
						billingProvider: "polar",
						providerSubscriptionId: "sub_polar",
						nowMs: now,
					}),
				),
			).rejects.toThrow("billing_period_owner_conflict");
			expect(period.overageCapMicros).toBe(70000000);
			const event = {
				provider: "boxd",
				eventId: "execution",
				type: "completed",
				payload: {},
				receivedAtMs: now,
				expiresAtMs: now + 86400000,
			};
			await runtime.runPromise(store.recordProviderEvent(event));
			const batch = {
				provider: "boxd",
				eventId: "execution",
				providerExecutionId: "execution",
				finalizedAtMs: now,
				usage: [
					{
						entryId: "entry",
						accountId: "account",
						periodId: period.periodId,
						resourceKind: "workspace" as const,
						resourceId: "workspace",
						provider: "boxd",
						providerExecutionId: "execution",
						startedAt: now - 90000,
						endedAt: now - 80000,
						vcpuCount: 2,
						memoryMib: 8192,
						providerCostMicros: 36000000,
						status: "confirmed" as const,
						nowMs: now,
					},
				],
			};
			await db.query(
				"ALTER TABLE api_cloud_billing_outbox ADD CONSTRAINT reject_export CHECK (amount_cents <= 10)",
			);
			await expect(
				runtime.runPromise(store.recordProviderExecutionBatch(batch)),
			).rejects.toThrow();
			expect(
				(
					await db.query(
						"SELECT * FROM api_cloud_billing_ledger WHERE period_id='stripe-period'",
					)
				).rows,
			).toHaveLength(0);
			expect(
				(await db.query("SELECT * FROM api_cloud_usage_outbox")).rows,
			).toHaveLength(0);
			expect(
				await runtime.runPromise(
					store.isProviderEventFinalized("boxd", "execution", "execution"),
				),
			).toBe(false);
			await db.query(
				"ALTER TABLE api_cloud_billing_outbox DROP CONSTRAINT reject_export",
			);
			await Promise.all(
				Array.from({ length: 8 }, () =>
					runtime.runPromise(store.recordProviderExecutionBatch(batch)),
				),
			);
			const exports = (
				await runtime.runPromise(store.pendingOutbox(now, 20))
			).filter((item) => item.periodId === period.periodId);
			expect(exports).toHaveLength(1);
			expect(exports[0]).toMatchObject({
				provider: "stripe",
				amountCents: 105,
				occurredAtMs: now - 60000,
			});
			expect(
				(await runtime.runPromise(store.pendingUsageExports(now, 20)))[0],
			).toMatchObject({ billingProvider: "stripe", units: 36000000 });
			const summary = await runtime.runPromise(store.summary(period));
			expect(summary.includedUsedMicros).toBe(35000000);
			expect(summary.overageChargeMicros).toBe(1050000);
			const exported = exports[0];
			if (!exported) throw new Error("Missing export");
			await runtime.runPromise(store.acknowledgeOutbox(exported.outboxId, now));
			const reconciliations = await runtime.runPromise(
				store.pendingMeterReconciliations(now + 300001, 20),
			);
			expect(
				reconciliations.find((item) => item.periodId === period.periodId),
			).toMatchObject({
				provider: "stripe",
				expectedUnits: 105,
				periodStartMs: now - 100000,
			});

			await runtime.runPromise(
				store.recordMeterReconciliation({
					periodId: period.periodId,
					provider: "stripe",
					expectedUnits: 105,
					observedUnits: 0,
					nowMs: now + 300001,
				}),
			);
			await runtime.runPromise(
				store.recordMeterReconciliation({
					periodId: period.periodId,
					provider: "stripe",
					expectedUnits: 105,
					observedUnits: 100,
					nowMs: now + 300002,
				}),
			);
			const retry = await runtime.runPromise(
				store.pendingMeterReconciliations(now + 600003, 20),
			);
			expect(
				retry.find((item) => item.periodId === period.periodId)?.expectedUnits,
			).toBe(105);
			await runtime.runPromise(
				store.recordMeterReconciliation({
					periodId: period.periodId,
					provider: "stripe",
					expectedUnits: 105,
					observedUnits: 105,
					nowMs: now + 600003,
				}),
			);
			expect(
				(
					await runtime.runPromise(
						store.pendingMeterReconciliations(now + 900004, 20),
					)
				).some((item) => item.periodId === period.periodId),
			).toBe(false);
			// More than one batch of old failures must not starve a newer period.
			const attemptNow = now + 2_000_000;
			for (let index = 0; index < 27; index++) {
				const periodId = `fair-${index.toString().padStart(2, "0")}`;
				await runtime.runPromise(
					store.ensurePeriod({
						periodId,
						accountId: periodId,
						billingProvider: "stripe",
						providerSubscriptionId: `sub_${periodId}`,
						status: "ended",
						periodStartMs: now - 100000,
						periodEndMs: now,
						nowMs: now,
					}),
				);
				await db.query(
					"INSERT INTO api_cloud_billing_outbox (outbox_id,period_id,account_id,provider,amount_cents,idempotency_key,attempt_count,next_attempt_at,created_at,occurred_at,acknowledged_at) VALUES ($1,$1,$1,'stripe',10,$1,0,0,$2,$2,$3)",
					[periodId, now - 1000, now + index],
				);
			}
			const firstBatch = await runtime.runPromise(
				store.pendingMeterReconciliations(attemptNow, 25),
			);
			expect(firstBatch).toHaveLength(25);
			expect(firstBatch.some((item) => item.periodId === "fair-26")).toBe(
				false,
			);
			for (const item of firstBatch)
				await runtime.runPromise(
					store.recordMeterReconciliationAttempt({
						periodId: item.periodId,
						provider: "stripe",
						nowMs: attemptNow,
					}),
				);
			for (const item of firstBatch.filter((_, index) => index % 2 === 0))
				await runtime.runPromise(
					store.recordMeterReconciliation({
						periodId: item.periodId,
						provider: "stripe",
						expectedUnits: 10,
						observedUnits: 0,
						nowMs: attemptNow,
					}),
				);
			const nextBatch = await runtime.runPromise(
				store.pendingMeterReconciliations(attemptNow + 1, 25),
			);
			expect(nextBatch.map((item) => item.periodId)).toContain("fair-26");
			expect(
				nextBatch.some((item) =>
					firstBatch.some((first) => first.periodId === item.periodId),
				),
			).toBe(false);
			// After cooldown, never-attempted periods still come before old failing ones.
			expect(
				(
					await runtime.runPromise(
						store.pendingMeterReconciliations(attemptNow + 300001, 2),
					)
				).map((item) => item.periodId),
			).toContain("fair-26");
			const observation = await db.query(
				"SELECT MAX(created_at) AS created_at FROM api_cloud_billing_meter_reconciliations WHERE period_id='fair-01'",
			);
			expect(observation.rows[0].created_at).toBeNull();
		} finally {
			await runtime.dispose();
			await db.query(`DROP SCHEMA ${schema} CASCADE`);
			await db.end();
		}
	},
	30000,
);
