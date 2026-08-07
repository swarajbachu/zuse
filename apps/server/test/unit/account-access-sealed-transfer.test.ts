import { generateKeyPairSync } from "node:crypto";
import { EnvironmentId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	openCredentialTransfer,
	prepareCredentialTransfer,
	sealCredentialTransfer,
	signPreparedImport,
	verifyPreparedImport,
} from "../../src/account-access/sealed-transfer.ts";

const binding = {
	accountId: "user_01JZUSE0000000000000000000",
	environmentId: EnvironmentId.make("01JZUSE0000000000000000000"),
	transferId: "access_01JZUSE0000000000000000000",
	expiresAt: 1_800_000_300_000,
};

describe("account-access sealed transfers", () => {
	it("authenticates the destination key against the environment identity", async () => {
		const identity = generateKeyPairSync("ed25519");
		const prepared = prepareCredentialTransfer({
			...binding,
			expiresAt: Date.now() + 300_000,
		});
		const environmentProof = await signPreparedImport(
			prepared,
			JSON.stringify(identity.privateKey.export({ format: "jwk" })),
			"https://relay.staging.example",
		);
		const publicPrepared = { ...prepared, environmentProof };
		const publicJwk = JSON.stringify(
			identity.publicKey.export({ format: "jwk" }),
		);

		await expect(
			verifyPreparedImport(
				publicPrepared,
				publicJwk,
				"https://relay.staging.example",
			),
		).resolves.toBeUndefined();
		await expect(
			verifyPreparedImport(
				{ ...publicPrepared, recipientPublicKey: "renderer-substituted-key" },
				publicJwk,
				"https://relay.staging.example",
			),
		).rejects.toThrow();
	});

	it("opens a credential only with the prepared account and environment binding", () => {
		const prepared = prepareCredentialTransfer(binding);
		const sealed = sealCredentialTransfer(
			{ ...binding, recipientPublicKey: prepared.recipientPublicKey },
			{
				providerId: "claude",
				kind: "oauth-token",
				secret: "oauth-secret",
			},
		);

		expect(openCredentialTransfer(prepared, sealed, 1_800_000_000_000)).toEqual(
			{
				providerId: "claude",
				kind: "oauth-token",
				secret: "oauth-secret",
			},
		);
	});

	it("rejects expiry, tampering, and ciphertext from another transfer", () => {
		const prepared = prepareCredentialTransfer(binding);
		const sealed = sealCredentialTransfer(
			{ ...binding, recipientPublicKey: prepared.recipientPublicKey },
			{
				providerId: "claude",
				kind: "oauth-token",
				secret: "oauth-secret",
			},
		);
		const other = prepareCredentialTransfer({
			...binding,
			transferId: "access_other",
		});

		expect(() =>
			openCredentialTransfer(prepared, sealed, binding.expiresAt + 1),
		).toThrow("transfer_expired");
		expect(() =>
			openCredentialTransfer(
				prepared,
				{
					...sealed,
					ciphertext: `${sealed.ciphertext[0] === "A" ? "B" : "A"}${sealed.ciphertext.slice(1)}`,
				},
				1_800_000_000_000,
			),
		).toThrow("transfer_rejected");
		expect(() =>
			openCredentialTransfer(other, sealed, 1_800_000_000_000),
		).toThrow("transfer_rejected");
	});

	it("rejects oversized credentials before encryption", () => {
		const prepared = prepareCredentialTransfer(binding);
		expect(() =>
			sealCredentialTransfer(
				{ ...binding, recipientPublicKey: prepared.recipientPublicKey },
				{
					providerId: "claude",
					kind: "oauth-token",
					secret: "x".repeat(20_000),
				},
			),
		).toThrow("transfer_too_large");
	});
});
