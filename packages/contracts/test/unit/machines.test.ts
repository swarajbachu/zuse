import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
	AccountAccessCustomConfigRequest,
	AccountAccessSetCredentialRequest,
	AccountAccessStatus,
	AccountAccessTransferEvent,
	ApiConnectGrant,
	BillingCheckoutRequest,
	CLOUD_WORKSPACE_OFFER_ID,
	MachineCreateRequest,
	MachineOffer,
	MachineRecord,
	MachineRuntimeStatus,
	PERSISTENT_STANDARD_OFFER_ID,
	SshMode,
} from "../../src/index.ts";

const offer = {
	offerId: PERSISTENT_STANDARD_OFFER_ID,
	displayName: "Persistent Standard",
	architecture: "x86_64" as const,
	vcpuCount: 4,
	memoryMib: 8_192,
	diskGib: 80,
	location: "Germany",
	monthlyPriceCents: 1_900,
	currency: "USD",
	automaticBackups: true,
	available: true,
};

describe("managed machine contracts", () => {
	it("defaults legacy machine offers to the persistent kind", () => {
		const decoded = Schema.decodeUnknownSync(MachineOffer)(offer);

		expect(decoded.kind).toBe("persistent");
	});

	it("decodes the server-owned offer and public machine fields", () => {
		const record = Schema.decodeUnknownSync(MachineRecord)({
			machineId: "machine_1",
			offer,
			label: "Build box",
			state: "ready",
			desiredState: "ready",
			statusCode: "ready",
			bootPhase: "account-setup-available",
			environmentId: "01JZUSE0000000000000000000",
			createdAt: 1_800_000_000_000,
			paidThrough: 1_802_678_400_000,
		});

		expect(record.offer.offerId).toBe(PERSISTENT_STANDARD_OFFER_ID);
		expect(record.state).toBe("ready");
		expect(record.bootPhase).toBe("account-setup-available");
	});

	it("requires an offer and idempotency key for creation", () => {
		const decoded = Schema.decodeUnknownSync(MachineCreateRequest)({
			offerId: PERSISTENT_STANDARD_OFFER_ID,
			label: "Build box",
			idempotencyKey: "create_01JZUSE0000000000000000000",
		});

		expect(decoded.idempotencyKey).toContain("create_");
		expect(() =>
			Schema.decodeUnknownSync(MachineCreateRequest)({
				offerId: PERSISTENT_STANDARD_OFFER_ID,
			}),
		).toThrow();
	});

	it("keeps the checkout return URL server-owned", () => {
		const decoded = Schema.decodeUnknownSync(BillingCheckoutRequest)({
			offerId: CLOUD_WORKSPACE_OFFER_ID,
		});

		expect(decoded).toEqual({
			offerId: CLOUD_WORKSPACE_OFFER_ID,
		});
	});

	it("rejects legacy client-controlled provider placement", () => {
		expect(() =>
			Schema.decodeUnknownSync(MachineCreateRequest)({
				label: "Build box",
				region: "user-selected",
				serverType: "user-selected",
			}),
		).toThrow();
	});

	it("does not expose raw provider fields in an encoded record", () => {
		const decoded = Schema.decodeUnknownSync(MachineRecord)({
			machineId: "machine_1",
			offer,
			state: "ready",
			desiredState: "ready",
			statusCode: "ready",
			createdAt: 1_800_000_000_000,
			providerServerId: "private-provider-id",
			rawError: "private provider payload",
		});
		const encoded = Schema.encodeSync(MachineRecord)(decoded);

		expect(encoded).not.toHaveProperty("providerServerId");
		expect(encoded).not.toHaveProperty("rawError");
	});

	it("supports mutually exclusive SSH modes", () => {
		expect(Schema.decodeUnknownSync(SshMode)("authorized-keys")).toBe(
			"authorized-keys",
		);
		expect(Schema.decodeUnknownSync(SshMode)("tailnet-identity")).toBe(
			"tailnet-identity",
		);
		expect(() => Schema.decodeUnknownSync(SshMode)("both")).toThrow();
	});

	it("advertises a private endpoint before the managed fallback", () => {
		const grant = Schema.decodeUnknownSync(ApiConnectGrant)({
			endpoint: {
				httpBaseUrl: "https://managed.example",
				wsBaseUrl: "wss://managed.example",
			},
			endpointCandidates: [
				{
					kind: "private-network",
					endpoint: {
						httpBaseUrl: "http://100.64.0.1:47837",
						wsBaseUrl: "ws://100.64.0.1:47837",
					},
				},
				{
					kind: "managed-tunnel",
					endpoint: {
						httpBaseUrl: "https://managed.example",
						wsBaseUrl: "wss://managed.example",
					},
				},
			],
			connectToken: "grant",
			expiresAt: 1_800_000_000_000,
		});

		expect(
			grant.endpointCandidates?.map((candidate) => candidate.kind),
		).toEqual(["private-network", "managed-tunnel"]);
	});

	it("decodes safe account-access status without credential material", () => {
		const status = Schema.decodeUnknownSync(AccountAccessStatus)({
			providers: [
				{
					providerId: "codex",
					state: "connected",
					installed: true,
					accountLabel: "ChatGPT Plus",
					authMethod: "subscription",
					verifiedAt: 1_800_000_000_000,
				},
			],
		});

		expect(status.providers[0]?.providerId).toBe("codex");
		expect(JSON.stringify(status)).not.toContain("token");
	});

	it("decodes durable cloud runtime update progress", () => {
		const status = Schema.decodeUnknownSync(MachineRuntimeStatus)({
			state: "updating",
			phase: "restarting",
			progressPercent: 85,
			targetAppVersion: "0.17.1",
			installedAppVersion: "0.16.0",
			installedRuntimeVersion: "old-runtime",
			targetRuntimeVersion: "new-runtime",
			updatedAt: 1_800_000_000_000,
		});

		expect(status.phase).toBe("restarting");
		expect(status.progressPercent).toBe(85);
	});

	it("accepts target-owned credentials and custom provider metadata", () => {
		const credential = Schema.decodeUnknownSync(
			AccountAccessSetCredentialRequest,
		)({
			providerId: "claude",
			method: "subscription",
			secret: "sk-ant-oat01-machine-token",
		});
		const custom = Schema.decodeUnknownSync(AccountAccessCustomConfigRequest)({
			providerId: "codex",
			baseUrl: "https://gateway.example/v1",
			secret: "provider-secret",
			modelProvider: "company-gateway",
		});

		expect(credential.method).toBe("subscription");
		expect(custom.modelProvider).toBe("company-gateway");
	});

	it("allows only safe progress events during browser authorization", () => {
		expect(
			Schema.decodeUnknownSync(AccountAccessTransferEvent)({
				_tag: "verification",
				url: "https://example.test/device",
				code: "ABCD-EFGH",
			}),
		).toMatchObject({ _tag: "verification", code: "ABCD-EFGH" });
		expect(() =>
			Schema.decodeUnknownSync(AccountAccessTransferEvent)({
				_tag: "sealed",
				secret: "must-not-cross-the-wire",
			}),
		).toThrow();
	});
});
