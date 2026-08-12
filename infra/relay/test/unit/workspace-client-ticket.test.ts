import { Effect } from "effect";
import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, test } from "vitest";
import {
	signWorkspaceClientTicket,
	verifyWorkspaceClientTicket,
} from "../../src/crypto.ts";

const nowMs = 1_800_000_000_000;

const fixture = async () => {
	const keys = await generateKeyPair("EdDSA", { extractable: true });
	const input = {
		mintPrivateJwk: await exportJWK(keys.privateKey),
		issuer: "https://relay.example.test",
		accountId: "account-1",
		workspaceId: "workspace-1",
		ttlMs: 5 * 60_000,
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
					expectedWorkspaceId: input.workspaceId,
					nowMs: at,
				}),
			);

		await expect(verify(nowMs)).resolves.toMatchObject({
			accountId: input.accountId,
			workspaceId: input.workspaceId,
			scope: "workspace-client",
		});
		await expect(verify(nowMs + 4 * 60_000)).resolves.toBeDefined();
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
					expectedWorkspaceId: input.workspaceId,
					nowMs,
					...overrides,
				}),
			);

		await expect(verify({ nowMs: nowMs + 6 * 60_000 })).rejects.toBeDefined();
		await expect(verify({ token: modified })).rejects.toBeDefined();
		await expect(
			verify({ expectedAccountId: "account-2" }),
		).rejects.toBeDefined();
		await expect(
			verify({ expectedWorkspaceId: "workspace-2" }),
		).rejects.toBeDefined();
	});
});
