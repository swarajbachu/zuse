import { Effect } from "effect";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, test } from "vitest";
import {
	signWorkspaceClientTicket,
	signWorkspaceRuntimeTicket,
	verifyRuntimeRenewalProof,
	verifyWorkspaceClientTicket,
	verifyWorkspaceRuntimeTicket,
} from "../../src/crypto.ts";

const nowMs = 1_800_000_000_000;

const fixture = async () => {
	const keys = await generateKeyPair("EdDSA", { extractable: true });
	const input = {
		mintPrivateJwk: await exportJWK(keys.privateKey),
		issuer: "https://api.example.test",
		accountId: "account-1",
		deviceId: "device-1",
		workspaceId: "workspace-1",
		protocol: "zuse-workspace-v2",
		generation: 3,
		gatewayEpoch: 4,
		ttlMs: 60_000,
		nowMs,
	};
	const token = await Effect.runPromise(signWorkspaceClientTicket(input));
	return { input, token, publicJwk: await exportJWK(keys.publicKey) };
};

describe("workspace client tickets", () => {
	test("one ticket can authenticate repeated connections during its lifetime", async () => {
		const { input, token, publicJwk } = await fixture();
		const verify = (at: number) =>
			Effect.runPromise(
				verifyWorkspaceClientTicket({
					token,
					mintPublicJwk: publicJwk,
					issuer: input.issuer,
					expectedAccountId: input.accountId,
					expectedDeviceId: input.deviceId,
					expectedWorkspaceId: input.workspaceId,
					expectedProtocol: input.protocol,
					expectedGeneration: input.generation,
					expectedGatewayEpoch: input.gatewayEpoch,
					nowMs: at,
				}),
			);

		await expect(verify(nowMs)).resolves.toMatchObject({
			accountId: input.accountId,
			deviceId: input.deviceId,
			workspaceId: input.workspaceId,
			scope: "workspace-client",
			role: "client",
			protocol: input.protocol,
			generation: input.generation,
			gatewayEpoch: input.gatewayEpoch,
		});
		await expect(verify(nowMs + 59_000)).resolves.toBeDefined();
	});

	test("rejects expiry, modification, wrong account, and wrong workspace", async () => {
		const { input, token, publicJwk } = await fixture();
		const parts = token.split(".");
		const payload = parts[1] ?? "";
		const modified = [
			parts[0],
			`${payload.startsWith("A") ? "B" : "A"}${payload.slice(1)}`,
			parts[2],
		].join(".");
		const verify = (
			overrides: Partial<Parameters<typeof verifyWorkspaceClientTicket>[0]>,
		) =>
			Effect.runPromise(
				verifyWorkspaceClientTicket({
					token,
					mintPublicJwk: publicJwk,
					issuer: input.issuer,
					expectedAccountId: input.accountId,
					expectedDeviceId: input.deviceId,
					expectedWorkspaceId: input.workspaceId,
					expectedProtocol: input.protocol,
					expectedGeneration: input.generation,
					expectedGatewayEpoch: input.gatewayEpoch,
					nowMs,
					...overrides,
				}),
			);

		await expect(verify({ nowMs: nowMs + 61_000 })).rejects.toBeDefined();
		await expect(verify({ token: modified })).rejects.toBeDefined();
		await expect(
			verify({ expectedAccountId: "account-2" }),
		).rejects.toBeDefined();
		await expect(
			verify({ expectedDeviceId: "device-2" }),
		).rejects.toBeDefined();
		await expect(
			verify({ expectedWorkspaceId: "workspace-2" }),
		).rejects.toBeDefined();
		await expect(
			verify({ expectedGeneration: input.generation + 1 }),
		).rejects.toBeDefined();
		await expect(
			verify({ expectedGatewayEpoch: input.gatewayEpoch + 1 }),
		).rejects.toBeDefined();
	});
});

describe("workspace runtime tickets", () => {
	test("verifies gateway scope without a workspace database lookup", async () => {
		const keys = await generateKeyPair("EdDSA", { extractable: true });
		const mintPrivateJwk = await exportJWK(keys.privateKey);
		const mintPublicJwk = await exportJWK(keys.publicKey);
		const input = {
			mintPrivateJwk,
			issuer: "https://api.example.test",
			accountId: "account-1",
			workspaceId: "workspace-1",
			protocol: "zuse-workspace-v2",
			generation: 3,
			gatewayEpoch: 4,
			ttlMs: 60_000,
			nowMs,
		};
		const token = await Effect.runPromise(signWorkspaceRuntimeTicket(input));
		await expect(
			Effect.runPromise(
				verifyWorkspaceRuntimeTicket({
					token,
					mintPublicJwk,
					issuer: input.issuer,
					expectedWorkspaceId: input.workspaceId,
					expectedProtocol: input.protocol,
					nowMs,
				}),
			),
		).resolves.toMatchObject({
			accountId: input.accountId,
			role: "runtime",
			generation: input.generation,
			gatewayEpoch: input.gatewayEpoch,
		});
	});
});

describe("runtime renewal proof", () => {
	test("binds proof to workspace, renewal id, generation, and gateway epoch", async () => {
		const keys = await generateKeyPair("EdDSA", { extractable: true });
		const publicJwk = await exportJWK(keys.publicKey);
		const proof = await new SignJWT({
			workspaceId: "workspace-1",
			requestId: "renew-1",
			generation: 3,
			gatewayEpoch: 4,
		})
			.setProtectedHeader({
				alg: "EdDSA",
				typ: "workspace-runtime-renewal+jwt",
			})
			.setAudience("https://api.example.test")
			.setIssuedAt(Math.floor(nowMs / 1_000))
			.setExpirationTime(Math.floor((nowMs + 60_000) / 1_000))
			.sign(keys.privateKey);
		const verify = (overrides = {}) =>
			Effect.runPromise(
				verifyRuntimeRenewalProof({
					proof,
					runtimeSigningPublicJwk: publicJwk,
					apiIssuer: "https://api.example.test",
					workspaceId: "workspace-1",
					requestId: "renew-1",
					generation: 3,
					gatewayEpoch: 4,
					nowMs,
					...overrides,
				}),
			);
		await expect(verify()).resolves.toMatchObject({ requestId: "renew-1" });
		await expect(verify({ requestId: "renew-2" })).rejects.toBeDefined();
		await expect(verify({ generation: 4 })).rejects.toBeDefined();
		await expect(verify({ gatewayEpoch: 5 })).rejects.toBeDefined();
	});
});
