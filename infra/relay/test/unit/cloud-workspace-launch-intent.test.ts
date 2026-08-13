import { Effect, Layer, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import {
	CloudWorkspaceLaunchIntentCipher,
	CloudWorkspaceLaunchIntentCipherLive,
	makeCloudWorkspaceLaunchIntent,
} from "../../src/cloud-workspace-launch-intent.ts";
import * as Config from "../../src/config.ts";

const config = Config.layer({
	relayIssuer: "https://relay.test",
	workosJwksUrl: "https://unused.test/jwks",
	workosIssuer: "https://unused.test",
	mintPrivateKey: Redacted.make("{}"),
	mintPublicKey: "{}",
	cloudCredentialVaultKey: Redacted.make(
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
	),
});

const layer = Layer.effect(
	CloudWorkspaceLaunchIntentCipher,
	CloudWorkspaceLaunchIntentCipherLive,
).pipe(Layer.provide(config));

describe("cloud workspace launch intent encryption", () => {
	test("derives bounded catalog metadata only inside the launch-intent boundary", () => {
		expect(
			makeCloudWorkspaceLaunchIntent({
				workspaceId: "workspace-1",
				branch: "zuse/workspace-1",
				agent: "codex",
				model: "gpt-5",
				permissions: [],
				request: {
					firstMessage: `${"x".repeat(90)}\nprivate second line`,
				},
			}),
		).toEqual({
			commandId: "launch:workspace-1",
			turnId: "turn:workspace-1",
			title: `${"x".repeat(77)}…`,
			agent: "codex",
			model: "gpt-5",
			permissions: [],
			firstMessage: `${"x".repeat(90)}\nprivate second line`,
		});
	});

	test("round-trips only under its account and workspace binding", async () => {
		const intent = {
			commandId: "launch:workspace-1",
			turnId: "turn:workspace-1",
			title: "Launch title",
			agent: "codex",
			model: "gpt-5",
			permissions: ["workspace-write"],
			firstMessage: "private prompt",
		};
		const encrypted = await Effect.runPromise(
			Effect.gen(function* () {
				const cipher = yield* CloudWorkspaceLaunchIntentCipher;
				return yield* cipher.encrypt("account-1", "workspace-1", intent);
			}).pipe(Effect.provide(layer)),
		);
		expect(encrypted).not.toContain(intent.firstMessage);
		await expect(
			Effect.runPromise(
				Effect.gen(function* () {
					const cipher = yield* CloudWorkspaceLaunchIntentCipher;
					return yield* cipher.decrypt("account-1", "workspace-1", encrypted);
				}).pipe(Effect.provide(layer)),
			),
		).resolves.toEqual(intent);
		await expect(
			Effect.runPromise(
				Effect.gen(function* () {
					const cipher = yield* CloudWorkspaceLaunchIntentCipher;
					return yield* cipher.decrypt("account-1", "workspace-2", encrypted);
				}).pipe(Effect.provide(layer)),
			),
		).rejects.toBeDefined();
	});
});
