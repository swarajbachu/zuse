import { CLOUD_WORKSPACE_OFFER_ID } from "@zuse/contracts";
import {
	type SandboxProviderAdapter,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import { makeBoxSandboxProvider } from "@zuse/sandbox-providers/box";
import { makeSandboxProvidersFake } from "@zuse/sandbox-providers/testing";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { ingestBoxLifecycleEvent } from "../../src/cloud-billing-box.ts";
import { CloudBillingStore } from "../../src/cloud-billing-store.ts";
import { CloudBillingStoreMemory } from "../../src/cloud-billing-store-memory.ts";
import { verifyBoxSignature } from "../../src/cloud-billing-usage-sources/box.ts";
import { reserveProviderCost } from "../../src/cloud-workspace-reconciler.ts";
import {
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import { layer as configurationLayer } from "../../src/config.ts";
import { MachineStore, MachineStoreMemory } from "../../src/machine-store.ts";

const makeRuntime = async (
	adapter?: SandboxProviderAdapter,
	enforce = false,
) => {
	const mint = await generateKeyPair("EdDSA", { extractable: true });
	const config = configurationLayer({
		apiIssuer: "https://api.test",
		cloudBillingEnforcementEnabled: enforce,
		cloudBillingCutoverAtMs: Date.parse("2026-09-30T23:55:00.000Z"),
		workosJwksUrl: "https://unused.test/jwks",
		workosIssuer: "https://unused.test",
		mintPrivateKey: Redacted.make(
			JSON.stringify(await exportJWK(mint.privateKey)),
		),
		mintPublicKey: JSON.stringify(await exportJWK(mint.publicKey)),
	});
	return ManagedRuntime.make(
		Layer.mergeAll(
			config,
			CloudWorkspaceStoreMemory,
			CloudBillingStoreMemory,
			MachineStoreMemory,
			adapter === undefined
				? makeSandboxProvidersFake()
				: SandboxProviders.layer({
						registrations: [{ adapter }],
						defaultProviderId: "box",
					}).pipe(Layer.orDie),
		),
	);
};

const readyEvent = (boxId: string, eventId: string, createdAt: string) => ({
	id: eventId,
	type: "box.ready",
	createdAt,
	data: { box: { id: boxId, name: "zuse-cloud-workspace-1" }, state: "ready" },
});

const archivedEvent = (boxId: string, eventId: string, createdAt: string) => ({
	id: eventId,
	type: "box.archived",
	createdAt,
	data: {
		box: { id: boxId, name: "zuse-cloud-workspace-1" },
		state: "archived",
	},
});

const signaturePayload = {
	rawBody: '{"id":"evt_1"}',
	deliveryId: "evt_1",
	timestamp: "1755400000",
};

const signBox = async (secret: string): Promise<string> => {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const digest = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(
			`${signaturePayload.deliveryId}.${signaturePayload.timestamp}.${signaturePayload.rawBody}`,
		),
	);
	return `v1=${[...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")}`;
};

describe("box billing ingestion", () => {
	it("accepts a correctly signed webhook and rejects tampering", async () => {
		const signature = await signBox("webhook-secret");

		await expect(
			Effect.runPromise(
				verifyBoxSignature({
					...signaturePayload,
					signature,
					secret: "webhook-secret",
				}),
			),
		).resolves.toBe(true);
		await expect(
			Effect.runPromise(
				verifyBoxSignature({
					...signaturePayload,
					rawBody: '{"id":"evt_2"}',
					signature,
					secret: "webhook-secret",
				}),
			),
		).resolves.toBe(false);
		await expect(
			Effect.runPromise(
				verifyBoxSignature({
					...signaturePayload,
					signature,
					secret: "other-secret",
				}),
			),
		).resolves.toBe(false);
	});

	it("treats an opening event as non-final", async () => {
		const runtime = await makeRuntime();
		const event = readyEvent("bx_1", "evt_open", "2026-08-17T10:00:00.000Z");

		const result = await runtime.runPromise(
			ingestBoxLifecycleEvent({
				event,
				rawPayload: event,
				source: "webhook",
				deliveryId: "evt_open",
				nowMs: Date.parse(event.createdAt),
			}),
		);

		expect(result).toMatchObject({
			eventInserted: true,
			metered: false,
			reason: "non-final",
		});
		await runtime.dispose();
	});

	it("pairs a close event with the stored opening event", async () => {
		const runtime = await makeRuntime();
		const open = readyEvent("bx_1", "evt_open", "2026-08-17T10:00:00.000Z");
		const close = archivedEvent(
			"bx_1",
			"evt_close",
			"2026-08-17T11:00:00.000Z",
		);

		await runtime.runPromise(
			ingestBoxLifecycleEvent({
				event: open,
				rawPayload: open,
				source: "webhook",
				deliveryId: "evt_open",
				nowMs: Date.parse(open.createdAt),
			}),
		);
		const result = await runtime.runPromise(
			ingestBoxLifecycleEvent({
				event: close,
				rawPayload: close,
				source: "webhook",
				deliveryId: "evt_close",
				nowMs: Date.parse(close.createdAt),
			}),
		);

		// The window pairs (the opening event is found), and resolution then
		// stops at the store lookup because no workspace record exists for the
		// box in this harness.
		expect(result).toMatchObject({
			eventInserted: true,
			metered: false,
			reason: "unmatched",
		});
		const opening = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* CloudBillingStore).pairProviderOpening({
					provider: "box",
					providerResourceId: "bx_1",
					openingType: "box.ready",
					closingEventId: "evt_close",
					closedAtMs: Date.parse("2026-08-17T13:00:00Z"),
				});
			}),
		);
		expect(opening?.eventId).toBe("evt_open");
		await runtime.dispose();
	});

	it("treats a close event without an open window as unmatched", async () => {
		const runtime = await makeRuntime();
		const close = archivedEvent(
			"bx_9",
			"evt_orphan",
			"2026-08-17T11:00:00.000Z",
		);

		const result = await runtime.runPromise(
			ingestBoxLifecycleEvent({
				event: close,
				rawPayload: close,
				source: "poll",
				deliveryId: "poll:evt_orphan",
				nowMs: Date.parse(close.createdAt),
			}),
		);

		expect(result).toMatchObject({ metered: false, reason: "unmatched" });
		await runtime.dispose();
	});

	it("returns the latest opening event when a box cycles repeatedly", async () => {
		const runtime = await makeRuntime();
		const first = readyEvent("bx_1", "evt_open_1", "2026-08-17T10:00:00.000Z");
		const second = readyEvent("bx_1", "evt_open_2", "2026-08-17T12:00:00.000Z");

		for (const event of [first, second]) {
			await runtime.runPromise(
				ingestBoxLifecycleEvent({
					event,
					rawPayload: event,
					source: "webhook",
					deliveryId: event.id,
					nowMs: Date.parse(event.createdAt),
				}),
			);
		}
		const opening = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* CloudBillingStore).pairProviderOpening({
					provider: "box",
					providerResourceId: "bx_1",
					openingType: "box.ready",
					closingEventId: "evt_close",
					closedAtMs: Date.parse("2026-08-17T13:00:00Z"),
				});
			}),
		);

		expect(opening?.eventId).toBe("evt_open_2");
		await runtime.dispose();
	});
});

it("pairs by provider time and keeps retries pinned after later events arrive", async () => {
	const runtime = await makeRuntime();
	try {
		const store = await runtime.runPromise(CloudBillingStore);
		const record = async (
			id: string,
			occurredAtMs: number,
			receivedAtMs: number,
		) =>
			runtime.runPromise(
				store.recordProviderEvent({
					provider: "box",
					eventId: id,
					type: "box.ready",
					providerResourceId: "bx",
					payload: {},
					occurredAtMs,
					receivedAtMs,
					expiresAtMs: 100_000,
				}),
			);
		const pair = (closingEventId: string, closedAtMs: number) =>
			runtime.runPromise(
				store.pairProviderOpening({
					provider: "box",
					providerResourceId: "bx",
					openingType: "box.ready",
					closingEventId,
					closedAtMs,
				}),
			);
		await record("ready_2", 3000, 4000);
		expect(await pair("close_1", 2000)).toBeNull();
		await record("ready_1", 1000, 5000);
		expect(await pair("close_1", 2000)).toEqual({
			eventId: "ready_1",
			startedAtMs: 1000,
		});
		expect(await pair("close_2", 4000)).toEqual({
			eventId: "ready_2",
			startedAtMs: 3000,
		});
		await record("late_ready", 1500, 6000);
		expect(await pair("close_1", 2000)).toEqual({
			eventId: "ready_1",
			startedAtMs: 1000,
		});
		// Distinct webhook/poll closings for the same run retain one execution ID.
		expect(await pair("poll_close_2", 4000)).toEqual({
			eventId: "ready_2",
			startedAtMs: 3000,
		});
	} finally {
		await runtime.dispose();
	}
});

describe("Box reported cost settlement", () => {
	it.each([
		false,
		true,
	])("queries exact windows, retries atomically, and deduplicates closes with malformed periods=%s", async (malformedPeriods) => {
		const boundary = Date.parse("2026-10-01T00:00:00.000Z");
		const end = boundary + 600_000;
		const calls: Array<{ since: string; until: string }> = [];
		let failSecondWindow = true;
		const adapter = makeBoxSandboxProvider(
			{
				apiKey: Redacted.make("test-key"),
				templateSnapshot: "base",
				templateVersion: "v1",
			},
			{
				fetch: async (input) => {
					const url = new URL(String(input));
					const since = url.searchParams.get("since") ?? "";
					const until = url.searchParams.get("until") ?? "";
					calls.push({ since, until });
					if (Date.parse(since) === boundary && failSecondWindow)
						return new Response("unavailable", { status: 503 });
					return Response.json({
						ok: true,
						type: "box.usage",
						boxId: "bx_metered",
						boxType: "large",
						billingMultiplier: 2,
						since,
						until,
						seconds: Date.parse(since) === boundary ? 987 : 123,
						dollars: Date.parse(since) === boundary ? 0.00987 : 0.00123,
						secondsPerDollar: 100000,
						running: false,
					});
				},
			},
		);
		const runtime = await makeRuntime(adapter);
		const oldPeriodId = `cloud:account:${boundary - 86_400_000}`;
		const newPeriodId = `cloud:account:${boundary}`;
		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					yield* (yield* MachineStore).upsertEntitlement({
						entitlementId: "entitlement",
						accountId: "account",
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
						accountId: "account",
						provider: "box",
						providerSandboxId: "bx_metered",
						templateVersion: "v1",
						configurationDigest: "digest",
						state: "building",
						idempotencyKey: "build",
						nextActionAtMs: end,
						revision: 0,
						createdAtMs: boundary - 600_000,
						updatedAtMs: end,
					});
					yield* (yield* CloudBillingStore).ensurePeriod({
						periodId: oldPeriodId,
						accountId: "account",
						status: "manual",
						periodStartMs: boundary - 86_400_000,
						periodEndMs: boundary,
						nowMs: end,
					});
					if (malformedPeriods) {
						for (const [name, offset] of [
							["empty", 0],
							["inverted", -60_000],
						] as const) {
							yield* (yield* CloudBillingStore).ensurePeriod({
								periodId: name,
								accountId: "account",
								status: "manual",
								periodStartMs: boundary - 120_000,
								periodEndMs: boundary - 120_000 + offset,
								nowMs: end,
							});
						}
					}
				}),
			);
			const ingest = (
				event: ReturnType<typeof readyEvent>,
				source: "webhook" | "poll" = "webhook",
			) =>
				runtime.runPromise(
					ingestBoxLifecycleEvent({
						event,
						rawPayload: event,
						source,
						deliveryId: event.id,
						nowMs: end,
					}),
				);
			await ingest(
				readyEvent("bx_metered", "open", "2026-09-30T23:50:00.000Z"),
			);
			const close = archivedEvent(
				"bx_metered",
				"close",
				new Date(end).toISOString(),
			);
			await expect(ingest(close)).rejects.toThrow();
			const list = (periodId: string) =>
				runtime.runPromise(
					Effect.gen(function* () {
						return yield* (yield* CloudBillingStore).listUsage(
							periodId,
							undefined,
							100,
						);
					}),
				);
			expect((await list(oldPeriodId)).items).toHaveLength(0);
			expect((await list(newPeriodId)).items).toHaveLength(0);
			failSecondWindow = false;
			expect(await ingest(close)).toMatchObject({ metered: true });
			expect(calls.slice(-2)).toEqual([
				{
					since: "2026-09-30T23:55:00.000Z",
					until: "2026-10-01T00:00:00.000Z",
				},
				{
					since: "2026-10-01T00:00:00.000Z",
					until: "2026-10-01T00:10:00.000Z",
				},
			]);
			expect((await list(oldPeriodId)).items).toMatchObject([
				{ providerCostMicros: 1230, resourceId: "build", provider: "box" },
			]);
			expect((await list(newPeriodId)).items).toMatchObject([
				{ providerCostMicros: 9870, resourceId: "build", provider: "box" },
			]);
			if (malformedPeriods) {
				expect((await list("empty")).items).toHaveLength(0);
				expect((await list("inverted")).items).toHaveLength(0);
			}
			expect(calls).toHaveLength(4);
			const callCount = calls.length;
			expect(await ingest(close)).toMatchObject({ metered: false });
			expect(
				await ingest({ ...close, id: "poll-close" }, "poll"),
			).toMatchObject({ metered: false });
			expect(calls).toHaveLength(callCount);
			expect((await list(newPeriodId)).items).toHaveLength(1);
		} finally {
			await runtime.dispose();
		}
	});
});

it.each([
	true,
	false,
])("reserves reported Box cost with a forward allowance only when running=%s", async (running) => {
	const nowMs = Date.parse("2026-10-01T01:00:00.000Z");
	const startedAtMs = nowMs - 600_000;
	const adapter = makeBoxSandboxProvider(
		{
			apiKey: Redacted.make("test"),
			templateSnapshot: "base",
			templateVersion: "v1",
		},
		{
			fetch: async (input) => {
				const url = new URL(String(input));
				expect(Date.parse(url.searchParams.get("since") ?? "")).toBe(
					startedAtMs,
				);
				expect(Date.parse(url.searchParams.get("until") ?? "")).toBe(nowMs);
				return Response.json({
					ok: true,
					type: "box.usage",
					boxId: "bx_live",
					boxType: "large",
					billingMultiplier: 2,
					since: new Date(startedAtMs).toISOString(),
					until: new Date(nowMs).toISOString(),
					seconds: 1000,
					dollars: 0.01,
					secondsPerDollar: 100000,
					running,
				});
			},
		},
	);
	const runtime = await makeRuntime(adapter, true);
	try {
		const summary = await runtime.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudBillingStore;
				const period = yield* store.ensurePeriod({
					periodId: "live",
					accountId: "account",
					status: "manual",
					periodStartMs: startedAtMs,
					periodEndMs: nowMs + 86_400_000,
					nowMs,
				});
				expect(
					yield* reserveProviderCost({
						accountId: "account",
						resourceKind: "workspace",
						resourceId: "workspace",
						provider: "box",
						providerSandboxId: "bx_live",
						runningSinceMs: startedAtMs,
						nowMs,
						vcpuCount: 4,
						memoryMib: 8192,
					}),
				).toBe(false);
				expect(
					(yield* store.listUsage("live", undefined, 100)).items,
				).toMatchObject([
					{
						status: "provisional",
						providerCostMicros: running ? 11200 : 10000,
					},
				]);
				return yield* store.summary(period);
			}),
		);
		expect(summary).toMatchObject({
			providerCostMicros: running ? 11200 : 10000,
			usageProvisional: true,
		});
	} finally {
		await runtime.dispose();
	}
});
