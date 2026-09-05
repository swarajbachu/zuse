import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	apiWebhookPayloadSealContext,
	apiWebhookSecretSealContext,
	sealApiString,
} from "../../src/api-sealing.ts";
import {
	apiWebhookRetryDelayMs,
	deliverPendingApiWebhooks,
} from "../../src/api-webhook-dispatch.ts";
import { safeApiWebhookTarget } from "../../src/api-webhook-target.ts";
import {
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import { layer as configurationLayer } from "../../src/config.ts";

const config = configurationLayer({
	apiIssuer: "https://api.test",
	workosJwksUrl: "https://unused.test/jwks",
	workosIssuer: "https://unused.test",
	mintPrivateKey: Redacted.make("{}"),
	mintPublicKey: "{}",
	cloudDataEncryptionKey: Redacted.make(
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
	),
});

const makeRuntime = () =>
	ManagedRuntime.make(Layer.merge(config, CloudWorkspaceStoreMemory));

const recordPendingWebhookDelivery = (input: {
	readonly accountId: string;
	readonly webhookId: string;
	readonly deliveryId: string;
	readonly eventId: string;
	readonly nowMs: number;
	readonly body: string;
}) =>
	Effect.gen(function* () {
		const store = yield* CloudWorkspaceStore;
		const sealedPayload = yield* sealApiString(
			apiWebhookPayloadSealContext(input.accountId, input.eventId),
			input.body,
		);
		yield* store.recordApiTurnEvent({
			messageId: `message-${input.eventId}`,
			workspaceId: `workspace-${input.eventId}`,
			accountId: input.accountId,
			turnId: `turn-${input.eventId}`,
			outcome: "completed",
			sealedContent: `sealed:${input.eventId}`,
			contentDigest: `digest:${input.eventId}`,
			nowMs: input.nowMs,
			receivedAtMs: input.nowMs,
			webhookFanout: {
				eventId: input.eventId,
				eventType: "workspace.turn.completed",
				sealedPayload,
				enqueuedAtMs: input.nowMs,
				targets: [
					{
						webhookId: input.webhookId,
						deliveryId: input.deliveryId,
					},
				],
			},
		});
	});

describe("API webhook dispatch", () => {
	afterEach(() => vi.unstubAllGlobals());

	test("accepts only canonical public targets outside the API host", () => {
		for (const target of [
			"https://api.test/hook",
			"https://API.TEST:443/hook",
			"https://api.test./hook",
			"https://api.test:8443/hook",
			"https://localhost/hook",
			"https://worker.localhost./hook",
			"https://box.local/hook",
			"https://127.0.0.1/hook",
			"https://2130706433/hook",
			"https://0177.0.0.1/hook",
			"https://10.0.0.1/hook",
			"https://169.254.169.254/hook",
			"https://[::1]/hook",
		])
			expect(
				safeApiWebhookTarget(target, "https://api.test"),
				target,
			).toBeNull();

		expect(
			safeApiWebhookTarget(
				"https://api.test.evil.example/hook",
				"https://api.test",
			)?.toString(),
		).toBe("https://api.test.evil.example/hook");
		expect(
			safeApiWebhookTarget(
				"https://hooks.example.com/zuse",
				"https://api.test",
			)?.toString(),
		).toBe("https://hooks.example.com/zuse");
	});

	test("uses the documented capped retry schedule", () => {
		expect(apiWebhookRetryDelayMs(1)).toBe(30_000);
		expect(apiWebhookRetryDelayMs(2)).toBe(60_000);
		expect(apiWebhookRetryDelayMs(8)).toBe(60 * 60_000);
		expect(apiWebhookRetryDelayMs(30)).toBe(60 * 60_000);
	});

	test("delivers a claimed batch concurrently", async () => {
		const runtime = makeRuntime();
		const store = await runtime.runPromise(CloudWorkspaceStore);
		const nowMs = Date.now() - 1;
		const secret = "whsec_test";
		await runtime.runPromise(
			store.createApiWebhook(
				{
					webhookId: "webhook-1",
					accountId: "account-1",
					url: "https://hooks.test/zuse",
					sealedSecret: await runtime.runPromise(
						sealApiString(
							apiWebhookSecretSealContext("account-1", "webhook-1"),
							secret,
						),
					),
					createdAtMs: nowMs,
				},
				20,
			),
		);
		for (const eventId of ["event-1", "event-2"]) {
			await runtime.runPromise(
				recordPendingWebhookDelivery({
					accountId: "account-1",
					webhookId: "webhook-1",
					deliveryId: `delivery-${eventId}`,
					eventId,
					nowMs,
					body: JSON.stringify({ eventId }),
				}),
			);
		}
		let started = 0;
		let release: (() => void) | undefined;
		const bothStarted = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.stubGlobal("fetch", async () => {
			started += 1;
			if (started === 2) release?.();
			await bothStarted;
			return new Response("ok", { status: 200 });
		});

		expect(await runtime.runPromise(deliverPendingApiWebhooks)).toBe(2);
		expect(started).toBe(2);
		await runtime.dispose();
	});

	test("does not follow redirects and retries the first failure after 30 seconds", async () => {
		const runtime = makeRuntime();
		const store = await runtime.runPromise(CloudWorkspaceStore);
		const nowMs = Date.now() - 1;
		await runtime.runPromise(
			store.createApiWebhook(
				{
					webhookId: "webhook-redirect",
					accountId: "account-1",
					url: "https://hooks.test/redirect",
					sealedSecret: await runtime.runPromise(
						sealApiString(
							apiWebhookSecretSealContext("account-1", "webhook-redirect"),
							"whsec_test",
						),
					),
					createdAtMs: nowMs,
				},
				20,
			),
		);
		await runtime.runPromise(
			recordPendingWebhookDelivery({
				accountId: "account-1",
				webhookId: "webhook-redirect",
				deliveryId: "delivery-redirect",
				eventId: "event-redirect",
				nowMs,
				body: "{}",
			}),
		);
		let redirect: RequestRedirect | undefined;
		vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
			redirect = init?.redirect;
			return new Response(null, {
				status: 302,
				headers: { location: "https://127.0.0.1/private" },
			});
		});

		expect(await runtime.runPromise(deliverPendingApiWebhooks)).toBe(0);
		expect(redirect).toBe("manual");
		const retry = await runtime.runPromise(
			store.claimDueApiWebhookDeliveries(
				Date.now() + apiWebhookRetryDelayMs(1) + 1_000,
				10,
				1_000,
			),
		);
		expect(retry).toHaveLength(1);
		expect(retry[0]?.delivery).toMatchObject({
			deliveryId: "delivery-redirect",
			attempts: 1,
			lastError: "http_302",
		});
		await runtime.dispose();
	});

	test("terminally rejects a persisted destination pointing back at the API", async () => {
		const runtime = makeRuntime();
		const store = await runtime.runPromise(CloudWorkspaceStore);
		const nowMs = Date.now() - 1;
		await runtime.runPromise(
			store.createApiWebhook(
				{
					webhookId: "webhook-loop",
					accountId: "account-1",
					url: "https://api.test./v1/api/projects",
					sealedSecret: await runtime.runPromise(
						sealApiString(
							apiWebhookSecretSealContext("account-1", "webhook-loop"),
							"whsec_test",
						),
					),
					createdAtMs: nowMs,
				},
				20,
			),
		);
		await runtime.runPromise(
			recordPendingWebhookDelivery({
				accountId: "account-1",
				webhookId: "webhook-loop",
				deliveryId: "delivery-loop",
				eventId: "event-loop",
				nowMs,
				body: "{}",
			}),
		);
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);

		expect(await runtime.runPromise(deliverPendingApiWebhooks)).toBe(0);
		expect(fetch).not.toHaveBeenCalled();
		expect(
			await runtime.runPromise(
				store.claimDueApiWebhookDeliveries(Date.now() + 86_400_000, 10, 1_000),
			),
		).toHaveLength(0);
		await runtime.dispose();
	});
});
