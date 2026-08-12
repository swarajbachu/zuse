import { Effect, Layer, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import {
	CloudChatCipher,
	CloudChatCipherLive,
} from "../../src/cloud-chat-cipher.ts";
import * as Config from "../../src/config.ts";

const key = (character: string) =>
	Redacted.make(Buffer.alloc(32, character).toString("base64url"));

const config = (active: string, keys: Readonly<Record<string, string>>) =>
	Config.layer({
		relayIssuer: "https://relay.test",
		workosJwksUrl: "https://unused.test/jwks",
		workosIssuer: "https://unused.test",
		mintPrivateKey: Redacted.make("unused"),
		mintPublicKey: "unused",
		cloudChatEncryptionActiveKeyId: active,
		cloudChatEncryptionKeys: Object.fromEntries(
			Object.entries(keys).map(([id, material]) => [id, key(material)]),
		),
	});

const layer = (active: string, keys: Readonly<Record<string, string>>) =>
	Layer.effect(CloudChatCipher, CloudChatCipherLive).pipe(
		Layer.provide(config(active, keys)),
	);

const context = {
	accountId: "account_a",
	workspaceId: "workspace_a",
	recordKind: "command" as const,
	recordId: "command_a",
	version: 1,
};

describe("CloudChatCipher", () => {
	test("round trips with the active key without exposing plaintext", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const cipher = yield* CloudChatCipher;
				const envelope = yield* cipher.encrypt(
					context,
					"private prompt marker",
				);
				return {
					envelope,
					plaintext: yield* cipher.decrypt(context, envelope),
				};
			}).pipe(Effect.provide(layer("current", { current: "a" }))),
		);
		expect(result.plaintext).toBe("private prompt marker");
		expect(result.envelope).not.toContain("private prompt marker");
		expect(JSON.parse(result.envelope)).toMatchObject({
			version: 1,
			keyId: "current",
		});
	});

	test.each([
		["account", { ...context, accountId: "account_b" }],
		["workspace", { ...context, workspaceId: "workspace_b" }],
		["record kind", { ...context, recordKind: "runtime-event" as const }],
		["record id", { ...context, recordId: "command_b" }],
		["version", { ...context, version: 2 }],
	])("rejects ciphertext moved to a different %s", async (_label, changed) => {
		const exit = await Effect.runPromise(
			Effect.gen(function* () {
				const cipher = yield* CloudChatCipher;
				const envelope = yield* cipher.encrypt(context, "private");
				return yield* Effect.exit(cipher.decrypt(changed, envelope));
			}).pipe(Effect.provide(layer("current", { current: "a" }))),
		);
		expect(exit._tag).toBe("Failure");
	});

	test("reads old keys while writing only with the active key", async () => {
		const oldEnvelope = await Effect.runPromise(
			Effect.gen(function* () {
				const cipher = yield* CloudChatCipher;
				return yield* cipher.encrypt(context, "old message");
			}).pipe(Effect.provide(layer("old", { old: "a" }))),
		);
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const cipher = yield* CloudChatCipher;
				const plaintext = yield* cipher.decrypt(context, oldEnvelope);
				const next = yield* cipher.encrypt(context, "new message");
				return { plaintext, next };
			}).pipe(Effect.provide(layer("current", { old: "a", current: "b" }))),
		);
		expect(result.plaintext).toBe("old message");
		expect(JSON.parse(result.next)).toMatchObject({ keyId: "current" });
	});

	test("fails closed when chat encryption is not configured", async () => {
		const missingConfig = Config.layer({
			relayIssuer: "https://relay.test",
			workosJwksUrl: "https://unused.test/jwks",
			workosIssuer: "https://unused.test",
			mintPrivateKey: Redacted.make("unused"),
			mintPublicKey: "unused",
		});
		const exit = await Effect.runPromise(
			Effect.gen(function* () {
				const cipher = yield* CloudChatCipher;
				return yield* Effect.exit(cipher.encrypt(context, "private"));
			}).pipe(
				Effect.provide(
					Layer.effect(CloudChatCipher, CloudChatCipherLive).pipe(
						Layer.provide(missingConfig),
					),
				),
			),
		);
		expect(exit._tag).toBe("Failure");
	});
});
