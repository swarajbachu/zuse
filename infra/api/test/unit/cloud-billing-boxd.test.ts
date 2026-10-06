import { CLOUD_WORKSPACE_OFFER_ID } from "@zuse/contracts";
import {
	SandboxProviderError,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import {
	boxdSandboxClientFor,
	makeBoxdSandboxProvider,
} from "@zuse/sandbox-providers/boxd";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { exportJWK, generateKeyPair } from "jose";
import { expect, it, vi } from "vitest";
import { CloudBillingStore } from "../../src/cloud-billing-store.ts";
import { CloudBillingStoreMemory } from "../../src/cloud-billing-store-memory.ts";
import {
	boxdBillingWindows,
	BoxdBillingUsageSourceModule as source,
} from "../../src/cloud-billing-usage-sources/boxd.ts";
import {
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import { layer as config } from "../../src/config.ts";
import { MachineStore, MachineStoreMemory } from "../../src/machine-store.ts";

const boundary = Date.parse("2026-10-01T00:00:00Z");
const event = {
	id: "usage:vm:day",
	machineId: "vm",
	startedAtMs: boundary - 60_000,
	endedAtMs: boundary + 60_000,
};
const key = Redacted.make("boxd-test");
const adapterConfig = {
	apiKey: key,
	templateSnapshot: "base",
	templateVersion: "v1",
	billingUsageEnabled: true,
};

it("uses stable, disjoint windows and waits for metering lag", () => {
	const start = boundary - 2 * 86_400_000;
	const first = boxdBillingWindows(start, boundary + 29 * 60_000);
	expect(first.at(-1)?.endedAtMs).toBe(boundary - 86_400_000);
	const next = boxdBillingWindows(start, boundary + 31 * 60_000);
	expect(next.slice(0, first.length)).toEqual(first);
	expect(next.at(-1)?.endedAtMs).toBe(boundary);
	expect(() => boxdBillingWindows(NaN, boundary)).toThrow();
});

it.each([
	undefined,
	boundary + 30_000,
])("uses boxd cutover independently of global cutover %s, splits costs and deduplicates retries", async (globalCutover) => {
	const mint = await generateKeyPair("EdDSA", { extractable: true });
	const calls: Array<{ startedAtMs: number; endedAtMs: number }> = [];
	let fail = true;
	const adapter = {
		...makeBoxdSandboxProvider(adapterConfig),
		getUsage: (
			_id: string,
			window: { startedAtMs: number; endedAtMs: number },
		) => {
			calls.push(window);
			return fail && window.startedAtMs === boundary
				? Effect.fail(new SandboxProviderError({ code: "transient" }))
				: Effect.succeed({
						...window,
						providerCostMicros: window.startedAtMs === boundary ? 200 : 100,
						billableSeconds: 60,
						running: false,
						costMicrosPerSecond: 0,
					});
		},
	};
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			config({
				apiIssuer: "https://test",
				cloudBillingCutoverAtMs: globalCutover,
				cloudBillingProviderCutoverAtMs: new Map([["boxd", boundary - 30_000]]),
				workosIssuer: "https://test",
				workosJwksUrl: "https://test/jwks",
				mintPrivateKey: Redacted.make(
					JSON.stringify(await exportJWK(mint.privateKey)),
				),
				mintPublicKey: JSON.stringify(await exportJWK(mint.publicKey)),
			}),
			CloudWorkspaceStoreMemory,
			CloudBillingStoreMemory,
			MachineStoreMemory,
			SandboxProviders.layer({
				registrations: [{ adapter }],
				defaultProviderId: "boxd",
			}).pipe(Layer.orDie),
		),
	);
	try {
		const billing = await runtime.runPromise(CloudBillingStore);
		await runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* MachineStore).upsertEntitlement({
					entitlementId: "ent",
					accountId: "acct",
					kind: "cloud-workspace",
					offerId: CLOUD_WORKSPACE_OFFER_ID,
					provider: "manual",
					status: "active",
					periodStartMs: boundary,
					paidThroughMs: boundary + 86_400_000,
					createdAtMs: boundary,
					updatedAtMs: boundary,
				});
				yield* (yield* CloudWorkspaceStore).createBuild({
					buildId: "build",
					projectId: "project",
					accountId: "acct",
					provider: "boxd",
					providerSandboxId: "replacement",
					templateVersion: "v1",
					configurationDigest: "digest",
					state: "ready",
					idempotencyKey: "build",
					nextActionAtMs: boundary,
					revision: 0,
					createdAtMs: boundary - 120_000,
					updatedAtMs: boundary,
				});
				yield* billing.recordRuntimeObservation({
					accountId: "acct",
					resourceKind: "build",
					resourceId: "build",
					provider: "boxd",
					providerSandboxId: "vm",
					observedAtMs: boundary,
					vcpuCount: 1,
					memoryMib: 4096,
				});
				yield* billing.ensurePeriod({
					periodId: `cloud:acct:${boundary - 86_400_000}`,
					accountId: "acct",
					status: "manual",
					periodStartMs: boundary - 86_400_000,
					periodEndMs: boundary,
					nowMs: boundary,
				});
			}),
		);
		const ingest = () =>
			runtime.runPromise(source.ingestPolled([event], boundary + 120_000));
		expect(await ingest()).toBe(0);
		expect(
			await runtime.runPromise(
				billing.isProviderEventFinalized("boxd", event.id),
			),
		).toBe(false);
		expect(
			await runtime.runPromise(
				billing.pendingUsageExports(boundary + 120_000, 20),
			),
		).toEqual([]);
		fail = false;
		const results = await Promise.all([ingest(), ingest()]);
		expect(results.reduce((a, b) => a + b)).toBe(1);
		expect(calls).toContainEqual({
			startedAtMs: boundary - 30_000,
			endedAtMs: boundary,
		});
		const exports = await runtime.runPromise(
			billing.pendingUsageExports(boundary + 120_000, 20),
		);
		expect(exports).toHaveLength(2);
		expect(exports.map((e) => e.units).sort((a, b) => a - b)).toEqual([
			100, 200,
		]);
		expect(
			exports.every(
				(e) =>
					e.metadata.resource_id === "build" &&
					e.metadata.measurement === "completed-provider-estimate",
			),
		).toBe(true);
		const count = calls.length;
		expect(await ingest()).toBe(0);
		expect(calls.length).toBe(count);
		expect(
			await runtime.runPromise(
				source.ingestPolled(
					[{ ...event, id: "unknown", machineId: "unknown" }],
					boundary + 120_000,
				),
			),
		).toBe(0);
	} finally {
		await runtime.dispose();
	}
});

it("polls complete machines including deleted ones and respects finalized identities", async () => {
	const client = boxdSandboxClientFor({ apiKey: key });
	const usage = vi.spyOn(client.orgs, "usage").mockResolvedValue({
		orgId: "org",
		org: "org",
		currency: "usd",
		complete: false,
		period: {
			start: new Date(boundary - 86_400_000),
			end: new Date(boundary),
		},
		rates: { vcpuHourMicro: 1, ramGibHourMicro: 1, diskGibHourMicro: 1 },
		totalCostMicro: 0,
		machines: [true, false].map((complete, i) => ({
			machineId: `vm${i}`,
			name: "unused",
			ownerId: null,
			ownerName: null,
			shared: false,
			status: "deleted",
			resources: { vcpu: 1, memoryBytes: 1024 ** 3, diskBytes: 0 },
			seconds: { running: 0, standby: 0, stopped: 0, hibernated: 0 },
			vcpuHours: 0,
			ramGibHours: 0,
			diskGibHours: 0,
			costMicro: 0,
			complete,
		})),
	});
	const api = {
		hasFinalizedProviderBillingEvent: vi.fn(async () => false),
		ingestProviderBillingEvents: vi.fn(
			async (
				_provider: string,
				_events: ReadonlyArray<unknown>,
				_now: number,
			) => 1,
		),
	};
	const env = {
		BOXD_ADAPTER_ENABLED: "true",
		BOXD_BILLING_ENABLED: "true",
		BOXD_API_KEY: "boxd-test",
		BOXD_BILLING_CUTOVER_AT: new Date(boundary - 86_400_000).toISOString(),
	};
	try {
		expect(
			await source.poll?.({
				env: { ...env, BOXD_BILLING_ENABLED: "false" },
				api,
				nowMs: boundary + 31 * 60_000,
			}),
		).toBe(0);
		expect(usage).not.toHaveBeenCalled();
		expect(
			await source.poll?.({ env, api, nowMs: boundary + 31 * 60_000 }),
		).toBe(1);
		expect(api.ingestProviderBillingEvents.mock.calls[0]?.[1]).toEqual([
			expect.objectContaining({ machineId: "vm0" }),
		]);
	} finally {
		usage.mockRestore();
	}
});
