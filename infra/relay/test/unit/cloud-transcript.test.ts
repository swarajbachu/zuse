import { Effect, Redacted } from "effect";
import { describe, expect, test } from "vitest";

import {
	cloudTranscriptObjectKey,
	cloudTranscriptMessagePageObjectKey,
	createCloudTranscriptKey,
	openCloudTranscriptKey,
	putCloudTranscriptObject,
} from "../../src/cloud-transcript.ts";
import * as Config from "../../src/config.ts";

const makeLayer = (objects: Config.CloudTranscriptObjectStore) =>
	Config.layer({
		relayIssuer: "https://relay.test",
		workosJwksUrl: "https://unused.test/jwks",
		workosIssuer: "https://unused.test",
		mintPrivateKey: Redacted.make("{}"),
		mintPublicKey: "{}",
		cloudCredentialVaultKey: Redacted.make(
			"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		),
		cloudTranscriptObjects: objects,
	});

describe("cloud transcript object storage", () => {
	test("uses generation and cursor in immutable object keys", () => {
		expect(
			cloudTranscriptObjectKey({
				workspaceId: "workspace/one",
				sessionId: "session/one",
				runtimeGeneration: 4,
				epoch: "epoch/one",
				version: 9,
			}),
		).toBe(
			"workspaces/workspace%2Fone/sessions/session%2Fone/generations/4/epoch%2Fone/9.json",
		);
		expect(
			cloudTranscriptMessagePageObjectKey({
				workspaceId: "workspace/one",
				sessionId: "session/one",
				runtimeGeneration: 4,
				epoch: "epoch/one",
				version: 9,
				beforeSequence: 500,
			}),
		).toBe(
			"workspaces/workspace%2Fone/sessions/session%2Fone/generations/4/epoch%2Fone/9/pages/500.json",
		);
	});

	test("accepts an idempotent retry but rejects different ciphertext at one key", async () => {
		const values = new Map<string, string>();
		const layer = makeLayer({
			put: async (key, value) => {
				if (values.has(key)) return "exists";
				values.set(key, value);
				return "created";
			},
			get: async (key) => values.get(key) ?? null,
			deletePrefix: async () => undefined,
		});
		const write = (value: string) =>
			Effect.runPromise(
				putCloudTranscriptObject("checkpoint", value).pipe(
					Effect.provide(layer),
				),
			);

		await expect(write("ciphertext-a")).resolves.toBeUndefined();
		await expect(write("ciphertext-a")).resolves.toBeUndefined();
		await expect(write("ciphertext-b")).rejects.toMatchObject({
			_tag: "CloudTranscriptStoreError",
			reason: "transcript_store_write_failed",
		});
	});

	test("wraps a random workspace key with workspace-bound authentication", async () => {
		const objects: Config.CloudTranscriptObjectStore = {
			put: async () => "created",
			get: async () => null,
			deletePrefix: async () => undefined,
		};
		const create = (workspaceId: string) =>
			Effect.runPromise(
				createCloudTranscriptKey("account-1", workspaceId).pipe(
					Effect.provide(makeLayer(objects)),
				),
			);
		const first = await create("workspace-1");
		const second = await create("workspace-1");

		expect(second.key).not.toBe(first.key);
		await expect(
			Effect.runPromise(
				openCloudTranscriptKey("account-1", "workspace-1", first.envelope).pipe(
					Effect.provide(makeLayer(objects)),
				),
			),
		).resolves.toBe(first.key);
		await expect(
			Effect.runPromise(
				openCloudTranscriptKey("account-1", "workspace-2", first.envelope).pipe(
					Effect.provide(makeLayer(objects)),
				),
			),
		).rejects.toMatchObject({
			_tag: "CloudTranscriptStoreError",
			reason: "transcript_key_unwrap_failed",
		});
	});
});
