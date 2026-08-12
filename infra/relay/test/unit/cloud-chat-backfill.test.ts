import { Effect, Layer, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import { backfillCloudChatEncryption } from "../../src/cloud-chat-backfill.ts";
import {
	CloudChatCipher,
	CloudChatCipherLive,
} from "../../src/cloud-chat-cipher.ts";
import {
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import * as Config from "../../src/config.ts";

const config = Config.layer({
	relayIssuer: "https://relay.test",
	workosJwksUrl: "https://unused.test/jwks",
	workosIssuer: "https://unused.test",
	mintPrivateKey: Redacted.make("unused"),
	mintPublicKey: "unused",
	cloudChatEncryptionActiveKeyId: "test",
	cloudChatEncryptionKeys: {
		test: Redacted.make(Buffer.alloc(32, "a").toString("base64url")),
	},
});
const cipher = Layer.effect(CloudChatCipher, CloudChatCipherLive).pipe(
	Layer.provide(config),
);
const layer = Layer.mergeAll(CloudWorkspaceStoreMemory, cipher);

describe("cloud chat encryption backfill", () => {
	test("verifies encrypted replacements before clearing every plaintext row", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const now = Date.now();
				const workspace = {
					workspaceId: "workspace_legacy",
					accountId: "account_a",
					projectId: "project_a",
					buildId: "build_a",
					provider: "provider_a",
					runtimeState: "offline" as const,
					chatId: "chat_a",
					initialSessionId: "session_a",
					branch: "branch_a",
					baseRef: "main",
					state: "paused" as const,
					desiredState: "paused" as const,
					statusCode: "paused",
					credentialEpoch: 1,
					idempotencyKey: "legacy",
					requestConfig: {
						title: "Private title",
						firstMessage: "Private prompt",
					},
					nextActionAtMs: now,
					revision: 1,
					createdAtMs: now,
					updatedAtMs: now,
					lastActivityAtMs: now,
				};
				yield* store.createWorkspace(workspace, {
					commandId: "command_a",
					workspaceId: workspace.workspaceId,
					accountId: workspace.accountId,
					sequence: 1,
					kind: "start-agent",
					payload: { firstMessage: "Private prompt" },
					state: "queued",
					createdAtMs: now,
				});
				yield* store.appendEvents(workspace.workspaceId, [
					{
						workspaceId: workspace.workspaceId,
						runtimeSequence: 1,
						eventId: "event_a",
						streamId: "stream_a",
						streamVersion: 1,
						type: "MessagePersisted",
						payloadJson: '{"text":"Private output"}',
						createdAtMs: now,
					},
				]);

				const result = yield* backfillCloudChatEncryption();
				expect(result).toEqual({ workspaces: 1, records: 3 });
				const migrated = yield* store.getWorkspace(workspace.workspaceId);
				expect(migrated?.chatMetadataCiphertext).toBeDefined();
				expect(JSON.stringify(migrated?.requestConfig)).not.toContain(
					"Private",
				);
				const commands = yield* store.listStoredCommands(workspace.workspaceId);
				expect(commands[0]?.payload).toBeUndefined();
				expect(commands[0]?.encryptedPayload).not.toContain("Private");
				const events = yield* store.listEvents(workspace.workspaceId, 0);
				expect(events[0]?.payloadJson).toBeUndefined();
				expect(events[0]?.encryptedPayload).not.toContain("Private");
			}).pipe(Effect.provide(layer)),
		);
	});
});
