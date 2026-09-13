import { Effect, Layer, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import {
	CloudWorkspaceLaunchIntentCipher,
	CloudWorkspaceLaunchIntentCipherLive,
	makeCloudWorkspaceLaunchIntent,
	selectCloudWorkspaceInitialMessageDelivery,
} from "../../src/cloud-workspace-launch-intent.ts";
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

const layer = Layer.effect(
	CloudWorkspaceLaunchIntentCipher,
	CloudWorkspaceLaunchIntentCipherLive,
).pipe(Layer.provide(config));

describe("cloud workspace launch intent encryption", () => {
	test("lets the server control initial mailbox delivery", () => {
		expect(
			selectCloudWorkspaceInitialMessageDelivery({
				mailboxEnabled: false,
				requested: "mailbox-v1",
			}),
		).toBeUndefined();
		expect(
			selectCloudWorkspaceInitialMessageDelivery({
				mailboxEnabled: true,
				requested: "mailbox-v1",
			}),
		).toBe("mailbox-v1");
	});

	test("derives bounded catalog metadata only inside the launch-intent boundary", () => {
		expect(
			makeCloudWorkspaceLaunchIntent({
				workspaceId: "workspace-1",
				branch: "zuse/workspace-1",
				agent: "codex",
				model: "gpt-5",
				runtimeMode: "full-access",
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
			runtimeMode: "full-access",
			permissions: [],
			firstMessage: `${"x".repeat(90)}\nprivate second line`,
		});
	});

	test("creates only the session shell when the first message uses the mailbox", () => {
		expect(
			makeCloudWorkspaceLaunchIntent({
				workspaceId: "workspace-1",
				branch: "zuse/workspace-1",
				agent: "codex",
				model: "gpt-5",
				runtimeMode: "full-access",
				permissions: [],
				request: {
					firstMessage: "Durable initial prompt",
					initialMessageDelivery: "mailbox-v1",
				},
			}),
		).toEqual({
			commandId: "launch:workspace-1",
			turnId: "turn:workspace-1",
			title: "Durable initial prompt",
			agent: "codex",
			model: "gpt-5",
			runtimeMode: "full-access",
			permissions: [],
		});
	});

	test("round-trips only under its account and workspace binding", async () => {
		const intent = {
			commandId: "launch:workspace-1",
			turnId: "turn:workspace-1",
			title: "Launch title",
			agent: "codex",
			model: "gpt-5",
			runtimeMode: "full-access" as const,
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
