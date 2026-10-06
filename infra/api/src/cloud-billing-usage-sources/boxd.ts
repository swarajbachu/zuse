import { SandboxProviders } from "@zuse/sandbox-providers";
import { boxdSandboxClientFor } from "@zuse/sandbox-providers/boxd";
import { Effect, Redacted, Schema } from "effect";
import { meterProviderExecution } from "../cloud-billing-provider.ts";
import { CloudBillingStore } from "../cloud-billing-store.ts";
import {
	type BillingUsageSourceModule,
	billingApiBaseUrl,
	ingestPolledBillingEvents,
} from "../cloud-billing-usage-source.ts";
import { CloudWorkspaceStore } from "../cloud-workspace-store.ts";
import { serviceUnavailable, unauthorized } from "../errors.ts";
import { boxdBillingConfigured } from "../sandbox-provider-availability.ts";

const Day = 86_400_000;

const Event = Schema.Struct({
	id: Schema.String,
	machineId: Schema.String,
	startedAtMs: Schema.Number,
	endedAtMs: Schema.Number,
});
const normalize = (payload: unknown) => {
	const result = Schema.decodeUnknownOption(Event)(payload);
	return result._tag === "Some" ? result.value : null;
};
const Environment = Schema.Struct({
	BOXD_ADAPTER_ENABLED: Schema.optionalKey(Schema.String),
	BOXD_BILLING_ENABLED: Schema.optionalKey(Schema.String),
	BOXD_API_KEY: Schema.optionalKey(Schema.String),
	BOXD_BASE_URL: Schema.optionalKey(Schema.String),
	BOXD_ORG: Schema.optionalKey(Schema.String),
	BOXD_BILLING_CUTOVER_AT: Schema.optionalKey(Schema.String),
});

// Fixed UTC windows keep identities stable across cron retries and restarts.
// The provider assigns each 15-minute bucket by its start timestamp.
export const boxdBillingWindows = (cutoverMs: number, nowMs: number) => {
	const end = Math.floor((nowMs - 30 * 60_000) / Day) * Day;
	if (
		!Number.isSafeInteger(cutoverMs) ||
		cutoverMs < 1 ||
		cutoverMs % 1000 !== 0
	)
		throw new Error(
			"boxd billing cutover must be a positive whole-second timestamp",
		);
	const windows: Array<{ startedAtMs: number; endedAtMs: number }> = [];
	for (let start = cutoverMs; start < end; ) {
		const next = Math.min((Math.floor(start / Day) + 1) * Day, end);
		windows.push({ startedAtMs: start, endedAtMs: next });
		start = next;
	}
	return windows;
};

export const BoxdBillingUsageSourceModule: BillingUsageSourceModule = {
	provider: "boxd",
	ingestWebhook: () => Effect.fail(unauthorized("boxd_billing_poll_only")),
	ingestPolled: (events, nowMs) =>
		ingestPolledBillingEvents({
			provider: "boxd",
			events,
			normalize,
			ingest: (event, payload) =>
				Effect.gen(function* () {
					const billing = yield* CloudBillingStore;
					// Finalization and ledger/outboxes are atomic in the shared settlement path.
					if (yield* billing.isProviderEventFinalized("boxd", event.id))
						return { metered: false };
					const store = yield* CloudWorkspaceStore;
					const workspace = yield* store.findWorkspaceByProviderSandbox(
						"boxd",
						event.machineId,
					);
					const build =
						workspace === null
							? yield* store.findBuildByProviderSandbox("boxd", event.machineId)
							: null;
					// Runtime observations retain attribution for replaced/deleted provider machines.
					const observation = yield* billing.getRuntimeObservation(
						"boxd",
						event.machineId,
					);
					const internalResourceId =
						workspace?.workspaceId ??
						build?.buildId ??
						(observation?.resourceKind === "workspace" ||
						observation?.resourceKind === "build"
							? observation.resourceId
							: undefined);
					if (internalResourceId === undefined) return { metered: false };
					const resource =
						workspace ??
						build ??
						(observation?.resourceKind === "workspace"
							? yield* store.getWorkspace(internalResourceId)
							: yield* store.getBuild(internalResourceId));
					if (
						resource === null ||
						(observation !== null &&
							observation.accountId !== resource.accountId)
					)
						return { metered: false };
					const adapter = yield* (yield* SandboxProviders)
						.get("boxd")
						.pipe(
							Effect.mapError(() =>
								serviceUnavailable("boxd_usage_unavailable"),
							),
						);
					const getUsage = adapter.getUsage;
					if (getUsage === undefined) return { metered: false };
					yield* billing.recordProviderEvent({
						provider: "boxd",
						eventId: event.id,
						type: "boxd.usage.window",
						providerResourceId: event.machineId,
						payload,
						receivedAtMs: nowMs,
						expiresAtMs: nowMs + 90 * Day,
					});
					return yield* meterProviderExecution({
						evidence: {
							provider: "boxd",
							eventId: event.id,
							providerExecutionId: event.id,
							internalResourceId,
							startedAtMs: Math.max(event.startedAtMs, resource.createdAtMs),
							endedAtMs: event.endedAtMs,
							vcpuCount: observation?.vcpuCount ?? adapter.resources.vcpuCount,
							memoryMib: observation?.memoryMib ?? adapter.resources.memoryMib,
						},
						reportedCost: (window) =>
							getUsage(event.machineId, window).pipe(
								Effect.flatMap((usage) =>
									billing
										.recordProviderEvent({
											provider: "boxd",
											eventId: `${event.id}:cost:${window.startedAtMs}:${window.endedAtMs}:${usage.providerCostMicros}`,
											type: "boxd.usage.cost",
											providerResourceId: event.machineId,
											payload: usage,
											receivedAtMs: nowMs,
											expiresAtMs: nowMs + 90 * Day,
										})
										.pipe(Effect.as(usage.providerCostMicros)),
								),
								Effect.mapError(() =>
									serviceUnavailable("boxd_usage_unavailable"),
								),
							),
						nowMs: nowMs,
					});
				}),
		}),
	poll: async ({ env, api, nowMs }) => {
		const config = Schema.decodeUnknownSync(Environment)(env);
		if (
			config.BOXD_ADAPTER_ENABLED !== "true" ||
			!boxdBillingConfigured(
				config.BOXD_BILLING_ENABLED,
				config.BOXD_BILLING_CUTOVER_AT,
			) ||
			!config.BOXD_API_KEY?.trim() ||
			!config.BOXD_BILLING_CUTOVER_AT?.trim()
		)
			return 0;
		const baseUrl =
			config.BOXD_BASE_URL === undefined
				? undefined
				: billingApiBaseUrl(config.BOXD_BASE_URL);
		const client = boxdSandboxClientFor({
			apiKey: Redacted.make(config.BOXD_API_KEY),
			baseUrl,
		});
		const windows = boxdBillingWindows(
			Date.parse(config.BOXD_BILLING_CUTOVER_AT),
			nowMs,
		);
		// Always settle the latest closed day. Rotate bounded historical batches to
		// recover missed ticks without re-reading years of history every minute.
		const batch =
			Math.floor(nowMs / 60_000) % Math.max(1, Math.ceil(windows.length / 7));
		const selected = new Map(
			windows
				.slice(batch * 7, batch * 7 + 7)
				.map((window) => [window.startedAtMs, window]),
		);
		const latest = windows.at(-1);
		if (latest !== undefined) selected.set(latest.startedAtMs, latest);
		const results = await Promise.all(
			[...selected.values()].map(async (window) => {
				try {
					const report = await client.orgs.usage({
						org: config.BOXD_ORG,
						since: window.startedAtMs / 1000,
						until: window.endedAtMs / 1000,
					});
					if (report.currency !== "usd")
						throw new Error(
							"boxd customer billing requires USD; no currency conversion policy is configured",
						);
					if (
						report.period.start.getTime() !== window.startedAtMs ||
						report.period.end.getTime() !== window.endedAtMs
					)
						throw new Error("boxd returned a different usage window");
					const events = [];
					for (const machine of report.machines) {
						if (!machine.complete) continue;
						const id = `usage:${machine.machineId}:${window.startedAtMs}:${window.endedAtMs}`;
						if (await api.hasFinalizedProviderBillingEvent("boxd", id, id))
							continue;
						events.push({ id, machineId: machine.machineId, ...window });
					}
					return await api.ingestProviderBillingEvents("boxd", events, nowMs);
				} catch (error) {
					console.warn("[cloud-billing] boxd usage window remains retryable", {
						startedAtMs: window.startedAtMs,
						endedAtMs: window.endedAtMs,
						error,
					});
					return 0;
				}
			}),
		);
		return results.reduce((total, count) => total + count, 0);
	},
};
