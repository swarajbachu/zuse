import { makeSandboxProvidersFake } from "@zuse/sandbox-providers/testing";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { ingestBoxLifecycleEvent } from "../../src/cloud-billing-box.ts";
import { CloudBillingStore } from "../../src/cloud-billing-store.ts";
import { CloudBillingStoreMemory } from "../../src/cloud-billing-store-memory.ts";
import { verifyBoxSignature } from "../../src/cloud-billing-usage-sources/box.ts";
import { CloudWorkspaceStoreMemory } from "../../src/cloud-workspace-store.ts";
import { layer as configurationLayer } from "../../src/config.ts";
import { MachineStoreMemory } from "../../src/machine-store.ts";

const makeRuntime = async () => {
	const mint = await generateKeyPair("EdDSA", { extractable: true });
	const config = configurationLayer({
		apiIssuer: "https://api.test",
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
			makeSandboxProvidersFake(),
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
				return yield* (yield* CloudBillingStore).latestProviderEvent(
					"box",
					"bx_1",
					"box.ready",
				);
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
				return yield* (yield* CloudBillingStore).latestProviderEvent(
					"box",
					"bx_1",
					"box.ready",
				);
			}),
		);

		expect(opening?.eventId).toBe("evt_open_2");
		await runtime.dispose();
	});
});
