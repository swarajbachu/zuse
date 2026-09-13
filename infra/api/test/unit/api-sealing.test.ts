import { Effect, Redacted } from "effect";
import { describe, expect, test, vi } from "vitest";
import {
	apiMessageSealContext,
	apiTurnReceiptDigestContext,
	digestApiString,
	openApiMessageString,
	openApiString,
	sealApiString,
} from "../../src/api-sealing.ts";
import * as Config from "../../src/config.ts";

const config = Config.layer({
	apiIssuer: "https://api.test",
	workosJwksUrl: "https://unused.test/jwks",
	workosIssuer: "https://unused.test",
	mintPrivateKey: Redacted.make("{}"),
	mintPublicKey: "{}",
	cloudDataEncryptionKey: Redacted.make(
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
	),
});

describe("public API content sealing", () => {
	test("binds message ciphertext to the individual ledger row", async () => {
		const importKey = vi.spyOn(crypto.subtle, "importKey");
		const context = apiMessageSealContext(
			"account-1",
			"workspace-1",
			"message-1",
		);
		const ciphertext = await Effect.runPromise(
			sealApiString(context, "private message").pipe(Effect.provide(config)),
		);
		expect(ciphertext).not.toContain("private message");
		await expect(
			Effect.runPromise(
				openApiString(context, ciphertext).pipe(Effect.provide(config)),
			),
		).resolves.toBe("private message");
		await expect(
			Effect.runPromise(
				openApiString(
					apiMessageSealContext("account-1", "workspace-1", "message-2"),
					ciphertext,
				).pipe(Effect.provide(config)),
			),
		).rejects.toBeDefined();
		expect(importKey).toHaveBeenCalledTimes(1);
		importKey.mockRestore();
	});

	test("opens legacy workspace-bound message rows during rollout", async () => {
		const legacyCiphertext = await Effect.runPromise(
			sealApiString(
				"message\naccount-1\nworkspace-1",
				"legacy private message",
			).pipe(Effect.provide(config)),
		);

		await expect(
			Effect.runPromise(
				openApiMessageString(
					"account-1",
					"workspace-1",
					"message-1",
					legacyCiphertext,
				).pipe(Effect.provide(config)),
			),
		).resolves.toBe("legacy private message");
	});

	test("does not let the legacy fallback weaken new row binding", async () => {
		const ciphertext = await Effect.runPromise(
			sealApiString(
				apiMessageSealContext("account-1", "workspace-1", "message-1"),
				"new private message",
			).pipe(Effect.provide(config)),
		);

		await expect(
			Effect.runPromise(
				openApiMessageString(
					"account-1",
					"workspace-1",
					"message-2",
					ciphertext,
				).pipe(Effect.provide(config)),
			),
		).rejects.toBeDefined();
	});

	test("creates stable row-bound keyed turn fingerprints", async () => {
		const context = apiTurnReceiptDigestContext(
			"account-1",
			"workspace-1",
			"turn-1",
		);
		const digest = await Effect.runPromise(
			digestApiString(context, "private reply").pipe(Effect.provide(config)),
		);
		expect(digest).toMatch(/^[0-9a-f]{64}$/u);
		expect(
			await Effect.runPromise(
				digestApiString(context, "private reply").pipe(Effect.provide(config)),
			),
		).toBe(digest);
		expect(
			await Effect.runPromise(
				digestApiString(
					apiTurnReceiptDigestContext("account-1", "workspace-1", "turn-2"),
					"private reply",
				).pipe(Effect.provide(config)),
			),
		).not.toBe(digest);
	});
});
