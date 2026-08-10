import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import {
	CloudCredentialVault,
	CloudCredentialVaultLive,
} from "../../src/cloud-credential-vault.ts";
import * as Config from "../../src/config.ts";

const config = Config.layer({
	relayIssuer: "https://relay.test",
	workosJwksUrl: "https://identity.test/jwks",
	workosIssuer: "https://identity.test",
	mintPrivateKey: Redacted.make("private"),
	mintPublicKey: "public",
	cloudCredentialVaultKey: Redacted.make(
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
	),
});

describe("cloud credential vault", () => {
	test("binds encrypted credentials to the account, kind, and version", async () => {
		const runtime = ManagedRuntime.make(
			Layer.effect(CloudCredentialVault, CloudCredentialVaultLive).pipe(
				Layer.provide(config),
				Layer.orDie,
			),
		);
		const vault = await runtime.runPromise(CloudCredentialVault);
		const payload = {
			credentialType: "api-key" as const,
			secret: "secret-value",
		};
		const encrypted = await runtime.runPromise(
			vault.encrypt("account-1", "claude", 2, payload),
		);
		expect(encrypted).not.toContain(payload.secret);
		expect(
			await runtime.runPromise(
				vault.decrypt("account-1", "claude", 2, encrypted),
			),
		).toEqual(payload);
		expect(
			await runtime.runPromise(
				Effect.exit(vault.decrypt("account-1", "claude", 3, encrypted)),
			),
		).toMatchObject({ _tag: "Failure" });
		await runtime.dispose();
	});
});
