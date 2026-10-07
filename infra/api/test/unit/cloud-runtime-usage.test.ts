import {
	BillingProviderError,
	BillingProviderManual,
	BillingProviders,
} from "@zuse/billing-providers";
import {
	FakeSandboxProviderControlService,
	makeSandboxProvidersFake,
} from "@zuse/sandbox-providers/testing";
import { Effect, Layer, Redacted, Ref } from "effect";
import { describe, expect, it, vi } from "vitest";
import { CloudBillingStore } from "../../src/cloud-billing-store.ts";
import { CloudBillingStoreMemory } from "../../src/cloud-billing-store-memory.ts";
import {
	flushCloudUsage,
	observeCloudRuntimeUsage,
} from "../../src/cloud-usage.ts";
import {
	makeCloudUsageStoreMemory,
	type RuntimeObservation,
	runtimeUsageInterval,
} from "../../src/cloud-usage-store.ts";
import { reserveProviderCost } from "../../src/cloud-workspace-reconciler.ts";
import { CloudWorkspaceStoreMemory } from "../../src/cloud-workspace-store.ts";
import { layer as configLayer } from "../../src/config.ts";

const observation: RuntimeObservation = {
	accountId: "account",
	resourceKind: "workspace",
	resourceId: "workspace",
	provider: "boxd",
	providerSandboxId: "machine",
	runningSinceMs: 1_000,
	observedAtMs: 1_000,
	vcpuCount: 2,
	memoryMib: 8192,
};
const config = (enabled: boolean) =>
	configLayer({
		apiIssuer: "https://api.test",
		workosJwksUrl: "https://unused.test/jwks",
		workosIssuer: "https://unused.test",
		mintPrivateKey: Redacted.make("{}"),
		mintPublicKey: '{"kty":"OKP"}',
		cloudUsageExportEnabled: enabled,
		cloudBillingExportEnabled: false,
	});

it.each([
	"box",
	"boxd",
])("records %s intervals once across retries and stale observations", async (provider) => {
	const store = makeCloudUsageStoreMemory();
	const record = (time: number) =>
		Effect.runPromise(
			store.recordRuntimeObservation({
				...observation,
				provider,
				observedAtMs: time,
			}),
		);
	await record(1_000);
	await Promise.all([record(61_000), record(61_000)]);
	await record(31_000);
	await record(121_000);
	const events = await Effect.runPromise(
		store.pendingUsageExports(121_000, 100),
	);
	expect(
		events.map((event) => [
			Date.parse(event.metadata.started_at ?? ""),
			Date.parse(event.metadata.ended_at ?? ""),
		]),
	).toEqual([
		[1_000, 61_000],
		[61_000, 121_000],
	]);
	await Effect.runPromise(
		store.acknowledgeUsageExport(events[0]?.eventId ?? "missing", 121_000),
	);
	await record(61_000);
	expect(
		await Effect.runPromise(store.pendingUsageExports(121_000, 100)),
	).toHaveLength(1);
});

describe("runtime observation boundaries", () => {
	it("does not invent historical runtime or fill outages", () => {
		expect(runtimeUsageInterval(undefined, observation)).toBeNull();
		expect(
			runtimeUsageInterval(observation, {
				...observation,
				observedAtMs: 122_000,
			}),
		).toBeNull();
	});
	it("does not count paused time, uncertain state, or another resource", () => {
		const later = { ...observation, observedAtMs: 61_000 };
		expect(
			runtimeUsageInterval(observation, {
				...later,
				runningSinceMs: undefined,
			}),
		).toBeNull();
		expect(
			runtimeUsageInterval(
				{ ...observation, runningSinceMs: undefined },
				later,
			),
		).toBeNull();
		for (const changes of [
			{ accountId: "other" },
			{ resourceId: "other" },
			{ resourceKind: "build" as const },
			{ provider: "box" },
			{ providerSandboxId: "other" },
		]) {
			expect(
				runtimeUsageInterval(observation, { ...later, ...changes }),
			).toBeNull();
		}
	});
	it("clips a restarted run at its new start", () => {
		expect(
			runtimeUsageInterval(observation, {
				...observation,
				runningSinceMs: 31_000,
				observedAtMs: 61_000,
			}),
		).toMatchObject({ startedAtMs: 31_000, endedAtMs: 61_000 });
	});
});

it("exports runtime independently of invoice export, preserving event identity across retry", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const store = Effect.runSync(
		CloudBillingStore.pipe(Effect.provide(CloudBillingStoreMemory)),
	);
	const sent: Array<
		Parameters<NonNullable<typeof BillingProviderManual.reportMeterEvent>>[0]
	> = [];
	let fail = true;
	const polar = {
		...BillingProviderManual,
		providerId: "polar",
		reportMeterEvent: (input: (typeof sent)[number]) =>
			Effect.gen(function* () {
				sent.push(input);
				if (fail && input.metadata?.provider === "boxd")
					return yield* Effect.fail(
						new BillingProviderError({ code: "provider-unavailable" }),
					);
			}),
	};
	const layer = Layer.mergeAll(
		CloudWorkspaceStoreMemory,
		config(true),
		Layer.succeed(CloudBillingStore, store),
		BillingProviders.layer({
			adapters: [polar],
			defaultProviderId: "polar",
		}).pipe(Layer.orDie),
	);
	try {
		for (const provider of ["boxd", "box"])
			for (const observedAtMs of [1_000, 61_000]) {
				await Effect.runPromise(
					store.recordRuntimeObservation({
						...observation,
						provider,
						observedAtMs,
					}),
				);
			}
		expect(
			await Effect.runPromise(
				flushCloudUsage(61_000).pipe(Effect.provide(layer)),
			),
		).toBe(1);
		expect(sent).toHaveLength(2);
		expect(sent[0]).toMatchObject({
			eventName: "zuse_cloud_runtime_observed_ms",
			accountId: "account",
			units: 60_000,
			occurredAtMs: 61_000,
			metadata: {
				provider: "box",
				resource_id: "workspace",
				billable: "false",
				measurement: "observed",
			},
		});
		const failed = sent.find((event) => event.metadata?.provider === "boxd");
		expect(
			await Effect.runPromise(
				flushCloudUsage(61_001).pipe(Effect.provide(layer)),
			),
		).toBe(0);
		fail = false;
		expect(
			await Effect.runPromise(
				flushCloudUsage(121_000).pipe(Effect.provide(layer)),
			),
		).toBe(1);
		expect(sent[2]).toEqual(failed);
		expect(
			await Effect.runPromise(
				flushCloudUsage(181_000).pipe(Effect.provide(layer)),
			),
		).toBe(0);
	} finally {
		warn.mockRestore();
	}
});

it("does not observe or export when the usage switch is disabled", async () => {
	const layer = Layer.mergeAll(
		CloudWorkspaceStoreMemory,
		config(false),
		CloudBillingStoreMemory,
		makeSandboxProvidersFake(),
		BillingProviders.layer({
			adapters: [BillingProviderManual],
			defaultProviderId: "manual",
		}).pipe(Layer.orDie),
	);
	await Effect.runPromise(
		observeCloudRuntimeUsage(observation).pipe(Effect.provide(layer)),
	);
	expect(
		await Effect.runPromise(
			flushCloudUsage(61_000).pipe(Effect.provide(layer)),
		),
	).toBe(0);
});

it("breaks observed intervals on hibernation and provider outages", async () => {
	const layer = Layer.mergeAll(
		CloudWorkspaceStoreMemory,
		config(true),
		CloudBillingStoreMemory,
		makeSandboxProvidersFake(),
	);
	await Effect.runPromise(
		Effect.gen(function* () {
			const control = yield* FakeSandboxProviderControlService;
			const store = yield* CloudBillingStore;
			const observe = (observedAtMs: number) =>
				reserveProviderCost({
					...observation,
					provider: "fake",
					nowMs: observedAtMs,
				});
			yield* Ref.set(
				control.sandboxes,
				new Map([
					[
						"machine",
						{
							providerSandboxId: "machine",
							providerLabel: "machine",
							state: "running",
						},
					],
				]),
			);
			yield* observe(1_000);
			yield* observe(61_000);
			yield* Ref.set(control.failNextInspect, true);
			yield* observe(121_000);
			yield* observe(181_000);
			yield* Ref.set(
				control.sandboxes,
				new Map([
					[
						"machine",
						{
							providerSandboxId: "machine",
							providerLabel: "machine",
							state: "paused",
						},
					],
				]),
			);
			yield* observe(241_000);
			const events = yield* store.pendingUsageExports(241_000, 100);
			expect(events.map((event) => event.units)).toEqual([60_000]);
		}).pipe(Effect.provide(layer)),
	);
});
