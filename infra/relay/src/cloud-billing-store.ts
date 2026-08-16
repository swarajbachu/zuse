import type {
	CloudBillingStatus,
	CloudBillingSummary,
	CloudBillingUsageItem,
} from "@zuse/contracts";
import { Clock, Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
	CLOUD_DEFAULT_OVERAGE_CAP_MICROS,
	CLOUD_PRICE_CATALOG_VERSION,
	calculateCloudBillingLedgerDeltas,
	calculateCloudBillingTotals,
	cloudBillingStatus,
	customerOverageCents,
	DEFAULT_CLOUD_BILLING_POLICY,
} from "./cloud-billing.ts";

export interface CloudBillingPeriodRecord {
	readonly periodId: string;
	readonly accountId: string;
	readonly providerSubscriptionId?: string;
	readonly status: CloudBillingStatus;
	readonly periodStartMs: number;
	readonly periodEndMs: number;
	readonly basePriceMicros: number;
	readonly includedProviderCostMicros: number;
	readonly markupBasisPoints: number;
	readonly priceCatalogVersion: string;
	readonly overageCapMicros: number;
}

export type CloudBillingUsageRecord = CloudBillingUsageItem & {
	readonly periodId: string;
	readonly accountId: string;
	readonly providerEventId?: string;
	readonly nowMs: number;
};

export interface CloudBillingStoreApi {
	readonly hasProviderEvent: (
		provider: string,
		eventId: string,
	) => Effect.Effect<boolean>;
	readonly isProviderEventFinalized: (
		provider: string,
		eventId: string,
		providerExecutionId?: string,
	) => Effect.Effect<boolean>;
	readonly priceWindows: (
		provider: string,
		startedAtMs: number,
		endedAtMs: number,
	) => Effect.Effect<
		ReadonlyArray<{
			readonly version: string;
			readonly startedAtMs: number;
			readonly endedAtMs: number;
			readonly baseNanoUsdPerSecond: number;
			readonly cpuNanoUsdPerSecond: number;
			readonly memoryNanoUsdPerGibSecond: number;
		}>
	>;
	readonly recordProviderEvent: (input: {
		readonly provider: string;
		readonly eventId: string;
		readonly type: string;
		readonly providerResourceId?: string;
		readonly payload: unknown;
		readonly receivedAtMs: number;
		readonly expiresAtMs: number;
	}) => Effect.Effect<boolean>;
	readonly recordProviderDelivery: (input: {
		readonly provider: string;
		readonly deliveryId: string;
		readonly eventId: string;
		readonly source: "webhook" | "poll";
		readonly status: "accepted" | "duplicate";
		readonly receivedAtMs: number;
	}) => Effect.Effect<void>;
	readonly ensurePeriod: (
		period: Omit<
			CloudBillingPeriodRecord,
			| "basePriceMicros"
			| "includedProviderCostMicros"
			| "markupBasisPoints"
			| "priceCatalogVersion"
			| "overageCapMicros"
		> &
			Partial<Pick<CloudBillingPeriodRecord, "overageCapMicros">> & {
				readonly nowMs: number;
			},
	) => Effect.Effect<CloudBillingPeriodRecord>;
	readonly currentPeriod: (
		accountId: string,
		nowMs: number,
	) => Effect.Effect<CloudBillingPeriodRecord | null>;
	readonly periodsOverlapping: (
		accountId: string,
		startedAtMs: number,
		endedAtMs: number,
	) => Effect.Effect<ReadonlyArray<CloudBillingPeriodRecord>>;
	readonly summary: (
		period: CloudBillingPeriodRecord,
	) => Effect.Effect<CloudBillingSummary>;
	readonly setCap: (
		period: CloudBillingPeriodRecord,
		capMicros: number,
		nowMs: number,
		idempotencyKey: string,
	) => Effect.Effect<
		CloudBillingPeriodRecord | "below-incurred" | "idempotency-conflict"
	>;
	readonly listUsage: (
		periodId: string,
		cursor: string | undefined,
		limit: number,
	) => Effect.Effect<{
		readonly items: ReadonlyArray<CloudBillingUsageItem>;
		readonly nextCursor?: string;
	}>;
	readonly recordProviderExecutionBatch: (input: {
		readonly provider: string;
		readonly eventId: string;
		readonly providerExecutionId: string | undefined;
		readonly finalizedAtMs: number;
		readonly usage: ReadonlyArray<CloudBillingUsageRecord>;
	}) => Effect.Effect<boolean>;
	readonly reserveCost: (input: {
		readonly periodId: string;
		readonly accountId: string;
		readonly resourceKind: "workspace" | "build";
		readonly resourceId: string;
		readonly provider: string;
		readonly providerCostMicros: number;
		readonly startedAtMs: number;
		readonly vcpuCount: number;
		readonly memoryMib: number;
		readonly nowMs: number;
		readonly expiresAtMs: number;
	}) => Effect.Effect<{
		readonly summary: CloudBillingSummary;
		readonly accepted: boolean;
	}>;
	readonly pendingOutbox: (
		nowMs: number,
		limit: number,
	) => Effect.Effect<
		ReadonlyArray<{
			readonly outboxId: string;
			readonly periodId: string;
			readonly accountId: string;
			readonly amountCents: number;
			readonly idempotencyKey: string;
			readonly createdAtMs: number;
		}>
	>;
	readonly acknowledgeOutbox: (
		outboxId: string,
		nowMs: number,
	) => Effect.Effect<void>;
	readonly retryOutbox: (
		outboxId: string,
		nowMs: number,
		error: string,
	) => Effect.Effect<void>;
	readonly pendingMeterReconciliations: (
		nowMs: number,
		limit: number,
	) => Effect.Effect<
		ReadonlyArray<{
			readonly periodId: string;
			readonly accountId: string;
			readonly expectedUnits: number;
		}>
	>;
	readonly recordMeterReconciliation: (input: {
		readonly periodId: string;
		readonly provider: string;
		readonly expectedUnits: number;
		readonly observedUnits: number;
		readonly nowMs: number;
	}) => Effect.Effect<void>;
	readonly purgeExpiredRawEvents: (nowMs: number) => Effect.Effect<number>;
}

export class CloudBillingStore extends Context.Service<
	CloudBillingStore,
	CloudBillingStoreApi
>()("@zuse/relay/CloudBillingStore") {}

interface PeriodRow {
	readonly period_id: string;
	readonly account_id: string;
	readonly provider_subscription_id: string | null;
	readonly status: CloudBillingStatus;
	readonly period_start: number;
	readonly period_end: number;
	readonly base_price_micros: number;
	readonly included_provider_cost_micros: number;
	readonly markup_basis_points: number;
	readonly price_catalog_version: string;
	readonly overage_cap_micros: number;
}
interface UsageRow {
	readonly entry_id: string;
	readonly resource_kind: "workspace" | "build" | "other";
	readonly resource_id: string;
	readonly provider: string;
	readonly provider_execution_id: string | null;
	readonly started_at: number;
	readonly ended_at: number;
	readonly vcpu_count: number;
	readonly memory_mib: number;
	readonly provider_cost_micros: number;
	readonly status: "provisional" | "confirmed" | "corrected";
}

const toPeriod = (row: PeriodRow): CloudBillingPeriodRecord => ({
	periodId: row.period_id,
	accountId: row.account_id,
	providerSubscriptionId: row.provider_subscription_id ?? undefined,
	status: row.status,
	periodStartMs: Number(row.period_start),
	periodEndMs: Number(row.period_end),
	basePriceMicros: Number(row.base_price_micros),
	includedProviderCostMicros: Number(row.included_provider_cost_micros),
	markupBasisPoints: Number(row.markup_basis_points),
	priceCatalogVersion: row.price_catalog_version,
	overageCapMicros: Number(row.overage_cap_micros),
});
const toUsage = (row: UsageRow): CloudBillingUsageItem => ({
	entryId: row.entry_id,
	resourceKind: row.resource_kind,
	resourceId: row.resource_id,
	provider: row.provider,
	providerExecutionId: row.provider_execution_id ?? undefined,
	startedAt: Number(row.started_at),
	endedAt: Number(row.ended_at),
	vcpuCount: Number(row.vcpu_count),
	memoryMib: Number(row.memory_mib),
	providerCostMicros: Number(row.provider_cost_micros),
	status: row.status,
});

export const CloudBillingStorePg = Layer.effect(
	CloudBillingStore,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const currentPeriod: CloudBillingStoreApi["currentPeriod"] = (
			accountId,
			nowMs,
		) =>
			sql<PeriodRow>`SELECT * FROM relay_cloud_billing_periods WHERE account_id = ${accountId} AND period_start <= ${nowMs} AND period_end > ${nowMs} ORDER BY period_start DESC LIMIT 1`.pipe(
				Effect.map((rows) => (rows[0] ? toPeriod(rows[0]) : null)),
				Effect.orDie,
			);
		const summary: CloudBillingStoreApi["summary"] = (period) =>
			Effect.gen(function* () {
				const nowMs = yield* Clock.currentTimeMillis;
				const totalsRows = yield* sql<{
					readonly confirmed_provider_cost: number;
					readonly confirmed_overage_charge: number;
					readonly reserved_provider_cost: number;
				}>`SELECT
					(SELECT COALESCE(SUM(amount_micros), 0) FROM relay_cloud_billing_ledger WHERE period_id = ${period.periodId} AND kind = 'provider-cost') AS confirmed_provider_cost,
					(SELECT COALESCE(SUM(amount_micros), 0) FROM relay_cloud_billing_ledger WHERE period_id = ${period.periodId} AND kind = 'overage-charge') AS confirmed_overage_charge,
					(SELECT COALESCE(SUM(provider_cost_micros), 0) FROM relay_cloud_billing_reservations WHERE period_id = ${period.periodId} AND expires_at > ${nowMs}) AS reserved_provider_cost`;
				const provisionalRows = yield* sql<{
					readonly present: boolean;
				}>`SELECT EXISTS(SELECT 1 FROM relay_cloud_billing_usage WHERE period_id = ${period.periodId} AND status = 'provisional') OR EXISTS(SELECT 1 FROM relay_cloud_billing_reservations WHERE period_id = ${period.periodId} AND expires_at > ${nowMs}) AS present`;
				const reconciliationRows = yield* sql<{
					readonly reconciled_at: number | null;
				}>`SELECT MAX(created_at) AS reconciled_at FROM relay_cloud_billing_usage WHERE period_id = ${period.periodId} AND status IN ('confirmed', 'corrected')`;
				const polarReconciliationRows = yield* sql<{
					readonly reconciled_at: number | null;
				}>`SELECT MAX(created_at) AS reconciled_at FROM relay_cloud_billing_meter_reconciliations WHERE period_id = ${period.periodId} AND provider = 'polar'`;
				const policy = {
					basePriceMicros: period.basePriceMicros,
					includedProviderCostMicros: period.includedProviderCostMicros,
					markupBasisPoints: period.markupBasisPoints,
				};
				const confirmedProviderCost = Number(
					totalsRows[0]?.confirmed_provider_cost ?? 0,
				);
				const confirmedOverageCharge = Number(
					totalsRows[0]?.confirmed_overage_charge ?? 0,
				);
				const reservedProviderCost = Number(
					totalsRows[0]?.reserved_provider_cost ?? 0,
				);
				const confirmedTotals = calculateCloudBillingTotals(
					confirmedProviderCost,
					policy,
				);
				const totals = calculateCloudBillingTotals(
					confirmedProviderCost + reservedProviderCost,
					policy,
				);
				const reservationCharge = Math.max(
					0,
					totals.overageChargeMicros - confirmedTotals.overageChargeMicros,
				);
				const overageChargeMicros = Math.min(
					period.overageCapMicros,
					confirmedOverageCharge + reservationCharge,
				);
				const status = cloudBillingStatus({
					subscriptionStatus:
						period.status === "ended"
							? "ended"
							: period.status === "grace" || period.status === "billing-hold"
								? "grace"
								: "active",
					manual: period.status === "manual",
					overageProviderCostMicros: totals.overageProviderCostMicros,
					overageChargeMicros,
					overageCapMicros: period.overageCapMicros,
				});
				return {
					currency: "USD" as const,
					status,
					periodStart: period.periodStartMs,
					periodEnd: period.periodEndMs,
					...totals,
					overageChargeMicros,
					currentInvoiceEstimateMicros:
						period.basePriceMicros + overageChargeMicros,
					basePriceMicros: period.basePriceMicros,
					includedProviderCostMicros: period.includedProviderCostMicros,
					overageCapMicros: period.overageCapMicros,
					markupBasisPoints: period.markupBasisPoints,
					lastProviderReconciledAt:
						reconciliationRows[0]?.reconciled_at === null ||
						reconciliationRows[0]?.reconciled_at === undefined
							? undefined
							: Number(reconciliationRows[0].reconciled_at),
					lastPolarReconciledAt:
						polarReconciliationRows[0]?.reconciled_at === null ||
						polarReconciliationRows[0]?.reconciled_at === undefined
							? undefined
							: Number(polarReconciliationRows[0].reconciled_at),
					usageProvisional: provisionalRows[0]?.present ?? false,
				};
			}).pipe(Effect.orDie);
		return CloudBillingStore.of({
			hasProviderEvent: (provider, eventId) =>
				sql<{
					readonly present: boolean;
				}>`SELECT EXISTS(SELECT 1 FROM relay_provider_usage_events WHERE provider = ${provider} AND event_id = ${eventId}) AS present`.pipe(
					Effect.map((rows) => rows[0]?.present ?? false),
					Effect.orDie,
				),
			isProviderEventFinalized: (provider, eventId, providerExecutionId) =>
				sql<{
					readonly finalized: boolean;
				}>`SELECT EXISTS(SELECT 1 FROM relay_provider_event_finalizations WHERE provider = ${provider} AND (event_id = ${eventId} OR (${providerExecutionId ?? null}::text IS NOT NULL AND provider_execution_id = ${providerExecutionId ?? null}))) AS finalized`.pipe(
					Effect.map((rows) => rows[0]?.finalized ?? false),
					Effect.orDie,
				),
			priceWindows: (provider, startedAtMs, endedAtMs) =>
				sql<{
					readonly version: string;
					readonly effective_at: number;
					readonly base_nano_usd_per_second: number;
					readonly cpu_nano_usd_per_second: number;
					readonly memory_nano_usd_per_gib_second: number;
				}>`SELECT version, effective_at, base_nano_usd_per_second, cpu_nano_usd_per_second, memory_nano_usd_per_gib_second FROM relay_provider_price_schedule WHERE provider = ${provider} AND effective_at < ${endedAtMs} ORDER BY effective_at ASC`.pipe(
					Effect.map((rows) => {
						const firstAfterStart = rows.findIndex(
							(row) => Number(row.effective_at) > startedAtMs,
						);
						const latestBeforeStart =
							firstAfterStart === -1 ? rows.length - 1 : firstAfterStart - 1;
						if (latestBeforeStart < 0) return [];
						const applicable = rows.filter(
							(row, index) =>
								index === latestBeforeStart ||
								Number(row.effective_at) > startedAtMs,
						);
						return applicable.map((row, index) => ({
							version: row.version,
							startedAtMs: Math.max(startedAtMs, Number(row.effective_at)),
							endedAtMs: Math.min(
								endedAtMs,
								Number(applicable[index + 1]?.effective_at ?? endedAtMs),
							),
							baseNanoUsdPerSecond: Number(row.base_nano_usd_per_second),
							cpuNanoUsdPerSecond: Number(row.cpu_nano_usd_per_second),
							memoryNanoUsdPerGibSecond: Number(
								row.memory_nano_usd_per_gib_second,
							),
						}));
					}),
					Effect.orDie,
				),
			recordProviderEvent: (input) =>
				sql<{
					readonly event_id: string;
				}>`INSERT INTO relay_provider_usage_events (provider, event_id, type, provider_resource_id, payload, received_at, expires_at) VALUES (${input.provider}, ${input.eventId}, ${input.type}, ${input.providerResourceId ?? null}, ${JSON.stringify(input.payload)}, ${input.receivedAtMs}, ${input.expiresAtMs}) ON CONFLICT DO NOTHING RETURNING event_id`.pipe(
					Effect.map((rows) => rows.length === 1),
					Effect.orDie,
				),
			recordProviderDelivery: (input) =>
				sql`INSERT INTO relay_provider_event_deliveries (provider, delivery_id, event_id, source, status, received_at) VALUES (${input.provider}, ${input.deliveryId}, ${input.eventId}, ${input.source}, ${input.status}, ${input.receivedAtMs}) ON CONFLICT DO NOTHING`.pipe(
					Effect.asVoid,
					Effect.orDie,
				),
			currentPeriod,
			periodsOverlapping: (accountId, startedAtMs, endedAtMs) =>
				sql<PeriodRow>`SELECT * FROM relay_cloud_billing_periods WHERE account_id = ${accountId} AND period_start < ${endedAtMs} AND period_end > ${startedAtMs} ORDER BY period_start ASC`.pipe(
					Effect.map((rows) => rows.map(toPeriod)),
					Effect.orDie,
				),
			ensurePeriod: (period) =>
				sql<PeriodRow>`INSERT INTO relay_cloud_billing_periods (
				period_id, account_id, provider_subscription_id, status, currency, period_start, period_end,
				base_price_micros, included_provider_cost_micros, markup_basis_points, price_catalog_version, overage_cap_micros,
				created_at, updated_at
			) VALUES (${period.periodId}, ${period.accountId}, ${period.providerSubscriptionId ?? null}, ${period.status}, 'USD',
				${period.periodStartMs}, ${period.periodEndMs}, ${DEFAULT_CLOUD_BILLING_POLICY.basePriceMicros},
				${DEFAULT_CLOUD_BILLING_POLICY.includedProviderCostMicros}, ${DEFAULT_CLOUD_BILLING_POLICY.markupBasisPoints}, ${CLOUD_PRICE_CATALOG_VERSION},
				${period.overageCapMicros ?? CLOUD_DEFAULT_OVERAGE_CAP_MICROS}, ${period.nowMs}, ${period.nowMs})
				ON CONFLICT (account_id, period_start) DO UPDATE SET status = EXCLUDED.status, period_end = EXCLUDED.period_end,
				provider_subscription_id = EXCLUDED.provider_subscription_id, updated_at = EXCLUDED.updated_at
				RETURNING *`.pipe(
					Effect.map((rows) => toPeriod(rows[0] as PeriodRow)),
					Effect.orDie,
				),
			summary,
			setCap: (period, capMicros, nowMs, idempotencyKey) =>
				Effect.gen(function* () {
					yield* sql`SELECT period_id FROM relay_cloud_billing_periods WHERE period_id = ${period.periodId} FOR UPDATE`;
					const commandRows = yield* sql<{
						readonly overage_cap_micros: number;
					}>`SELECT overage_cap_micros FROM relay_cloud_billing_cap_commands WHERE period_id = ${period.periodId} AND idempotency_key = ${idempotencyKey}`;
					if (commandRows[0] !== undefined) {
						if (Number(commandRows[0].overage_cap_micros) !== capMicros)
							return "idempotency-conflict" as const;
						const rows =
							yield* sql<PeriodRow>`SELECT * FROM relay_cloud_billing_periods WHERE period_id = ${period.periodId}`;
						return toPeriod(rows[0] as PeriodRow);
					}
					const incurredRows = yield* sql<{
						readonly total: number;
					}>`SELECT COALESCE(SUM(amount_micros), 0) AS total FROM relay_cloud_billing_ledger WHERE period_id = ${period.periodId} AND kind = 'overage-charge'`;
					if (capMicros < Number(incurredRows[0]?.total ?? 0))
						return "below-incurred" as const;
					yield* sql`INSERT INTO relay_cloud_billing_cap_commands (period_id, idempotency_key, overage_cap_micros, created_at) VALUES (${period.periodId}, ${idempotencyKey}, ${capMicros}, ${nowMs})`;
					const rows =
						yield* sql<PeriodRow>`UPDATE relay_cloud_billing_periods SET overage_cap_micros = ${capMicros}, updated_at = ${nowMs} WHERE period_id = ${period.periodId} RETURNING *`;
					return toPeriod(rows[0] as PeriodRow);
				}).pipe(sql.withTransaction, Effect.orDie),
			listUsage: (periodId, cursor, limit) =>
				sql<UsageRow>`SELECT * FROM (
					SELECT entry_id, resource_kind, resource_id, provider, provider_execution_id, started_at, ended_at, vcpu_count, memory_mib, provider_cost_micros, status
					FROM relay_cloud_billing_usage WHERE period_id = ${periodId}
					UNION ALL
					SELECT 'reservation:' || resource_kind || ':' || resource_id AS entry_id, resource_kind, resource_id, provider, NULL AS provider_execution_id,
						started_at, updated_at AS ended_at, vcpu_count, memory_mib, provider_cost_micros, 'provisional' AS status
					FROM relay_cloud_billing_reservations WHERE period_id = ${periodId} AND expires_at > EXTRACT(EPOCH FROM clock_timestamp()) * 1000
				) AS usage_items WHERE (${cursor ?? null}::text IS NULL OR entry_id < ${cursor ?? null}) ORDER BY entry_id DESC LIMIT ${limit + 1}`.pipe(
					Effect.map((rows) => ({
						items: rows.slice(0, limit).map(toUsage),
						...(rows.length > limit
							? { nextCursor: rows[limit - 1]?.entry_id }
							: {}),
					})),
					Effect.orDie,
				),
			recordProviderExecutionBatch: (batch) =>
				Effect.gen(function* () {
					if (
						batch.usage.length === 0 ||
						batch.usage.some(
							(item) =>
								item.provider !== batch.provider ||
								item.providerExecutionId !== batch.providerExecutionId,
						)
					)
						throw new Error("invalid provider execution batch");
					const eventRows = yield* sql<{
						readonly event_id: string;
					}>`SELECT event_id FROM relay_provider_usage_events WHERE provider = ${batch.provider} AND event_id = ${batch.eventId} FOR UPDATE`;
					if (eventRows[0] === undefined)
						throw new Error("provider usage event missing");
					const finalizedRows = yield* sql<{
						readonly finalized: boolean;
					}>`SELECT EXISTS(SELECT 1 FROM relay_provider_event_finalizations WHERE provider = ${batch.provider} AND (event_id = ${batch.eventId} OR (${batch.providerExecutionId ?? null}::text IS NOT NULL AND provider_execution_id = ${batch.providerExecutionId ?? null}))) AS finalized`;
					if (finalizedRows[0]?.finalized === true) return false;
					let metered = false;
					for (const input of batch.usage) {
						const periodRows =
							yield* sql<PeriodRow>`SELECT * FROM relay_cloud_billing_periods WHERE period_id = ${input.periodId} FOR UPDATE`;
						const period = toPeriod(periodRows[0] as PeriodRow);
						const beforeRows = yield* sql<{
							readonly provider_cost: number;
							readonly overage_charge: number;
						}>`SELECT
						COALESCE(SUM(amount_micros) FILTER (WHERE kind = 'provider-cost'), 0) AS provider_cost,
						COALESCE(SUM(amount_micros) FILTER (WHERE kind = 'overage-charge'), 0) AS overage_charge
						FROM relay_cloud_billing_ledger WHERE period_id = ${input.periodId}`;
						const inserted = yield* sql<{
							readonly entry_id: string;
						}>`INSERT INTO relay_cloud_billing_usage (
					entry_id, period_id, account_id, resource_kind, resource_id, provider, provider_event_id,
					provider_execution_id, started_at, ended_at, vcpu_count, memory_mib, provider_cost_micros, status, created_at
				) VALUES (${input.entryId}, ${input.periodId}, ${input.accountId}, ${input.resourceKind}, ${input.resourceId}, ${input.provider},
					${input.providerEventId ?? null}, ${input.providerExecutionId ?? null}, ${input.startedAt}, ${input.endedAt}, ${input.vcpuCount},
					${input.memoryMib}, ${input.providerCostMicros}, ${input.status}, ${input.nowMs}) ON CONFLICT DO NOTHING RETURNING entry_id`;
						if (inserted.length === 0) continue;
						yield* sql`DELETE FROM relay_cloud_billing_reservations WHERE period_id = ${input.periodId} AND resource_kind = ${input.resourceKind} AND resource_id = ${input.resourceId}`;
						yield* sql`INSERT INTO relay_cloud_billing_ledger (entry_id, period_id, account_id, kind, amount_micros, source_id, metadata, occurred_at, created_at)
					VALUES (${`ledger:${input.entryId}`}, ${input.periodId}, ${input.accountId}, 'provider-cost', ${input.providerCostMicros}, ${input.entryId}, ${JSON.stringify({ provider: input.provider, resourceKind: input.resourceKind, resourceId: input.resourceId })}, ${input.endedAt}, ${input.nowMs}) ON CONFLICT DO NOTHING`;
						const policy = {
							basePriceMicros: period.basePriceMicros,
							includedProviderCostMicros: period.includedProviderCostMicros,
							markupBasisPoints: period.markupBasisPoints,
						};
						const beforeProviderCost = Number(
							beforeRows[0]?.provider_cost ?? 0,
						);
						const beforeCharge = Number(beforeRows[0]?.overage_charge ?? 0);
						const deltas = calculateCloudBillingLedgerDeltas({
							beforeProviderCostMicros: beforeProviderCost,
							beforeChargedMicros: beforeCharge,
							providerCostDeltaMicros: input.providerCostMicros,
							overageCapMicros: period.overageCapMicros,
							manual: period.status === "manual",
							policy,
						});
						const financialEntries = [
							{
								kind: "included-allowance",
								amount: deltas.includedAllowanceMicros,
							},
							{
								kind: "overage-provider-cost",
								amount: deltas.overageProviderCostMicros,
							},
							{ kind: "overage-charge", amount: deltas.overageChargeMicros },
							{ kind: "markup", amount: deltas.markupMicros },
							{
								kind:
									period.status === "manual"
										? "manual-entitlement-credit"
										: "overshoot-absorbed",
								amount: deltas.absorbedMicros,
							},
						];
						for (const entry of financialEntries) {
							if (entry.amount === 0) continue;
							yield* sql`INSERT INTO relay_cloud_billing_ledger (entry_id, period_id, account_id, kind, amount_micros, source_id, metadata, occurred_at, created_at)
						VALUES (${`ledger:${entry.kind}:${input.entryId}`}, ${input.periodId}, ${input.accountId}, ${entry.kind}, ${entry.amount}, ${input.entryId}, '{}', ${input.endedAt}, ${input.nowMs}) ON CONFLICT DO NOTHING`;
						}
						const totalRows = yield* sql<{
							readonly total: number;
						}>`SELECT COALESCE(SUM(amount_micros), 0) AS total FROM relay_cloud_billing_ledger WHERE period_id = ${input.periodId} AND kind = 'overage-charge'`;
						const exportedRows = yield* sql<{
							readonly total: number;
						}>`SELECT COALESCE(SUM(amount_cents), 0) AS total FROM relay_cloud_billing_outbox WHERE period_id = ${input.periodId}`;
						const targetCents = customerOverageCents(
							Number(totalRows[0]?.total ?? 0),
						);
						const deltaCents =
							targetCents - Number(exportedRows[0]?.total ?? 0);
						if (deltaCents !== 0) {
							const sequenceRows = yield* sql<{
								readonly count: number;
							}>`SELECT COUNT(*) AS count FROM relay_cloud_billing_outbox WHERE period_id = ${input.periodId}`;
							const sequence = Number(sequenceRows[0]?.count ?? 0) + 1;
							yield* sql`INSERT INTO relay_cloud_billing_outbox (outbox_id, period_id, account_id, provider, amount_cents, idempotency_key, attempt_count, next_attempt_at, created_at)
						VALUES (${`outbox:${input.periodId}:${sequence}`}, ${input.periodId}, ${input.accountId}, 'polar', ${deltaCents}, ${`${input.periodId}:${sequence}`}, 0, ${input.nowMs}, ${input.nowMs}) ON CONFLICT DO NOTHING`;
						}
						metered = true;
					}
					yield* sql`INSERT INTO relay_provider_event_finalizations (provider, event_id, provider_execution_id, finalized_at, expires_at)
					VALUES (${batch.provider}, ${batch.eventId}, ${batch.providerExecutionId ?? null}, ${batch.finalizedAtMs}, ${batch.finalizedAtMs + 7 * 365 * 24 * 60 * 60 * 1_000}) ON CONFLICT DO NOTHING`;
					return metered;
				}).pipe(sql.withTransaction, Effect.orDie),
			reserveCost: (input) =>
				Effect.gen(function* () {
					const rows =
						yield* sql<PeriodRow>`SELECT * FROM relay_cloud_billing_periods WHERE period_id = ${input.periodId} FOR UPDATE`;
					yield* sql`INSERT INTO relay_cloud_billing_reservations (period_id, account_id, resource_kind, resource_id, provider, provider_cost_micros, started_at, vcpu_count, memory_mib, expires_at, updated_at)
					VALUES (${input.periodId}, ${input.accountId}, ${input.resourceKind}, ${input.resourceId}, ${input.provider}, ${input.providerCostMicros}, ${input.startedAtMs}, ${input.vcpuCount}, ${input.memoryMib}, ${input.expiresAtMs}, ${input.nowMs})
					ON CONFLICT (period_id, resource_kind, resource_id) DO UPDATE SET provider = EXCLUDED.provider, provider_cost_micros = EXCLUDED.provider_cost_micros, started_at = EXCLUDED.started_at, vcpu_count = EXCLUDED.vcpu_count, memory_mib = EXCLUDED.memory_mib, expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at`;
					const period = toPeriod(rows[0] as PeriodRow);
					const updatedSummary = yield* summary(period);
					const rawProjectedCharge = calculateCloudBillingTotals(
						updatedSummary.providerCostMicros,
						{
							basePriceMicros: period.basePriceMicros,
							includedProviderCostMicros: period.includedProviderCostMicros,
							markupBasisPoints: period.markupBasisPoints,
						},
					).overageChargeMicros;
					return {
						summary: updatedSummary,
						accepted:
							period.status === "manual" ||
							(period.status === "active" &&
								rawProjectedCharge <= period.overageCapMicros),
					};
				}).pipe(sql.withTransaction, Effect.orDie),
			pendingOutbox: (nowMs, limit) =>
				sql<{
					readonly outbox_id: string;
					readonly period_id: string;
					readonly account_id: string;
					readonly amount_cents: number;
					readonly idempotency_key: string;
					readonly created_at: number;
				}>`SELECT outbox_id, period_id, account_id, amount_cents, idempotency_key, created_at FROM relay_cloud_billing_outbox WHERE acknowledged_at IS NULL AND next_attempt_at <= ${nowMs} ORDER BY created_at ASC LIMIT ${limit}`.pipe(
					Effect.map((rows) =>
						rows.map((row) => ({
							outboxId: row.outbox_id,
							periodId: row.period_id,
							accountId: row.account_id,
							amountCents: Number(row.amount_cents),
							idempotencyKey: row.idempotency_key,
							createdAtMs: Number(row.created_at),
						})),
					),
					Effect.orDie,
				),
			acknowledgeOutbox: (outboxId, nowMs) =>
				sql`UPDATE relay_cloud_billing_outbox SET acknowledged_at = ${nowMs}, last_error = NULL WHERE outbox_id = ${outboxId}`.pipe(
					Effect.asVoid,
					Effect.orDie,
				),
			retryOutbox: (outboxId, nowMs, error) =>
				sql`UPDATE relay_cloud_billing_outbox SET attempt_count = attempt_count + 1, next_attempt_at = ${nowMs} + LEAST(900000, POWER(2, LEAST(attempt_count, 4))::bigint * 60000), last_error = ${error.slice(0, 500)} WHERE outbox_id = ${outboxId}`.pipe(
					Effect.asVoid,
					Effect.orDie,
				),
			pendingMeterReconciliations: (nowMs, limit) =>
				sql<{
					readonly period_id: string;
					readonly account_id: string;
					readonly expected_units: number;
				}>`SELECT p.period_id, p.account_id, SUM(o.amount_cents) AS expected_units
				FROM relay_cloud_billing_periods p
				JOIN relay_cloud_billing_outbox o ON o.period_id = p.period_id AND o.acknowledged_at IS NOT NULL
				LEFT JOIN relay_cloud_billing_meter_reconciliations r ON r.period_id = p.period_id AND r.provider = 'polar'
				WHERE p.period_end > ${nowMs} AND o.acknowledged_at <= ${nowMs - 5 * 60_000}
				GROUP BY p.period_id, p.account_id
				HAVING COALESCE(MAX(r.created_at), 0) < MAX(o.acknowledged_at)
				ORDER BY MAX(o.acknowledged_at) ASC LIMIT ${limit}`.pipe(
					Effect.map((rows) =>
						rows.map((row) => ({
							periodId: row.period_id,
							accountId: row.account_id,
							expectedUnits: Number(row.expected_units),
						})),
					),
					Effect.orDie,
				),
			recordMeterReconciliation: (input) =>
				sql`INSERT INTO relay_cloud_billing_meter_reconciliations
				(reconciliation_id, period_id, provider, expected_units, observed_units, created_at)
				VALUES (${`meter-reconciliation:${input.periodId}:${input.nowMs}`}, ${input.periodId}, ${input.provider}, ${input.expectedUnits}, ${input.observedUnits}, ${input.nowMs})
				ON CONFLICT DO NOTHING`.pipe(Effect.asVoid, Effect.orDie),
			purgeExpiredRawEvents: (nowMs) =>
				Effect.gen(function* () {
					yield* sql`DELETE FROM relay_provider_event_deliveries WHERE received_at <= ${nowMs - 90 * 24 * 60 * 60 * 1_000}`;
					yield* sql`DELETE FROM relay_provider_event_finalizations WHERE expires_at <= ${nowMs}`;
					const rows = yield* sql<{
						readonly event_id: string;
					}>`DELETE FROM relay_provider_usage_events WHERE expires_at <= ${nowMs} RETURNING event_id`;
					return rows.length;
				}).pipe(Effect.orDie),
		});
	}),
);
