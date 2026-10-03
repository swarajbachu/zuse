import { Effect, Redacted } from "effect";
import { expect, test } from "vitest";
import {
	openVersionedApiString,
	sealVersionedApiString,
} from "../../src/api-sealing.ts";
import * as Config from "../../src/config.ts";

const first = Redacted.make("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
const second = Redacted.make("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE");
const config = (key: typeof first, previous: readonly (typeof first)[] = []) =>
	Config.layer({
		apiIssuer: "https://api.test",
		workosIssuer: "https://unused",
		workosJwksUrl: "https://unused/jwks",
		mintPrivateKey: Redacted.make("{}"),
		mintPublicKey: "{}",
		cloudDataEncryptionKey: key,
		cloudDataPreviousEncryptionKeys: previous,
	});
test("rotation reads old values and rewrites with the new key without plaintext storage", async () => {
	const sealed = await Effect.runPromise(
		sealVersionedApiString("owner/revision", "private value").pipe(
			Effect.provide(config(first)),
		),
	);
	const plaintext = await Effect.runPromise(
		openVersionedApiString("owner/revision", sealed).pipe(
			Effect.provide(config(second, [first])),
		),
	);
	expect(plaintext).toBe("private value");
	const rotated = await Effect.runPromise(
		sealVersionedApiString("owner/revision-2", plaintext).pipe(
			Effect.provide(config(second)),
		),
	);
	expect(rotated).not.toContain(plaintext);
	expect(JSON.parse(rotated).keyId).not.toBe(JSON.parse(sealed).keyId);
	await expect(
		Effect.runPromise(
			openVersionedApiString("owner/revision-2", rotated).pipe(
				Effect.provide(config(second)),
			),
		),
	).resolves.toBe(plaintext);
	await expect(
		Effect.runPromise(
			openVersionedApiString("other-owner", rotated).pipe(
				Effect.provide(config(second)),
			),
		),
	).rejects.toBeDefined();
	await expect(
		Effect.runPromise(
			openVersionedApiString("owner/revision", sealed).pipe(
				Effect.provide(config(second)),
			),
		),
	).rejects.toBeDefined();
});
