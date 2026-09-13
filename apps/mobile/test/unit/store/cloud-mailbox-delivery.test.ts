import type {
	ClientCommand,
	CommandReceipt,
	OutboxEntry,
} from "@zuse/client-runtime/client-persistence";
import {
	type CloudCommandEnvelope,
	CommandId,
	MessageId,
	SessionId,
} from "@zuse/contracts";
import { bytesToBase64Url } from "@zuse/utils/cloud-transcript-crypto";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
	snapshot: { entries: [], receipts: [] } as {
		entries: OutboxEntry[];
		receipts: CommandReceipt[];
	},
	enqueue: vi.fn(),
	live: vi.fn(),
	status: vi.fn(),
	watches: [] as Array<(value: unknown) => void>,
}));
vi.mock("~/offline/cache", () => ({
	deletePath: () => Effect.void,
	messagesPath: () => "/messages/session.json",
	readClientCommandOutbox: () => Effect.succeed(state.snapshot),
	readMessagesSnapshot: () => Effect.succeed(null),
	writeMessagesSnapshot: () => Effect.void,
	writeClientCommandOutbox: (value: typeof state.snapshot) =>
		Effect.sync(() => {
			state.snapshot = structuredClone(value);
		}),
}));
vi.mock("~/rpc/connection", () => ({
	getConnectionClient: () => {
		state.live();
		return Effect.never;
	},
	isConnectionOnline: () => true,
	reportConnectionFailure: vi.fn(),
}));
vi.mock("~/rpc/api-client", () => ({
	cloudControlClient: {
		"cloud.commands.dataKey": () =>
			Effect.succeed({
				workspaceId: "workspace-1",
				encodedKey: bytesToBase64Url(new Uint8Array(32).fill(1)),
				keyVersion: 1,
				destructionFence: 0,
				mailboxEnabled: true,
			}),
		"cloud.commands.enqueue": (input: CloudCommandEnvelope) =>
			state.enqueue(input),
		"cloud.commands.status": () => state.status(),
		"cloud.commands.watch": () =>
			Effect.promise(
				() =>
					new Promise((resolve) => {
						state.watches.push(resolve);
					}),
			),
		"cloud.commands.cancel": () =>
			Effect.sync(() => {
				const status = {
					commandId: CommandId.make("message-send:one"),
					fingerprint: (
						state.snapshot.entries[0]?.encryptedEnvelope as
							| CloudCommandEnvelope
							| undefined
					)?.fingerprint,
					workspaceSequence: 1,
					revision: 3,
					state: "cancelled" as const,
					everLeased: false,
					updatedAt: 3,
				};
				for (const publish of state.watches.splice(0))
					publish({ changes: [status], nextRevision: 3, resetRequired: false });
				return status;
			}),
	},
}));

import { makeTextInput, sendCloudMessage } from "../../../src/rpc/actions";
import {
	mobileClientBus,
	registerMobileEnvironment,
	resetMobileClientBus,
} from "../../../src/store/mobile-client-bus";

const connection = {
	key: "cloud:workspace-1",
	cloudWorkspaceId: "workspace-1",
	environmentId: "workspace-1",
	host: "api.example",
	port: 443,
};
const acceptance = {
	commandId: CommandId.make("message-send:one"),
	workspaceSequence: 1,
	revision: 2,
	acceptedAt: 2,
	state: "waiting-for-runtime" as const,
};

describe("mobile mailbox delivery without a connected computer", () => {
	beforeEach(async () => {
		await resetMobileClientBus();
		state.snapshot = { entries: [], receipts: [] };
		state.live.mockClear();
		state.enqueue.mockReset().mockReturnValue(Effect.succeed(acceptance));
		state.status.mockReset().mockImplementation(() =>
			Effect.succeed({
				...acceptance,
				fingerprint: (
					state.snapshot.entries[0]?.encryptedEnvelope as
						| CloudCommandEnvelope
						| undefined
				)?.fingerprint,
				everLeased: false,
				updatedAt: 2,
			}),
		);
	});
	afterEach(async () => {
		await resetMobileClientBus();
		for (const publish of state.watches.splice(0))
			publish({ changes: [], nextRevision: 3, resetRequired: false });
	});
	test("accepts encrypted content and persists acceptance before any runtime connection", async () => {
		const handle = sendCloudMessage({
			connection,
			sessionId: SessionId.make("session-1"),
			input: makeTextInput("Only the agent can read this"),
			clientMessageId: MessageId.make("one"),
		});
		void handle.result.catch(() => undefined);
		await handle.accepted;
		expect(state.live).not.toHaveBeenCalled();
		expect(state.snapshot.entries[0]?.acceptance).toMatchObject(acceptance);
		const envelope = state.enqueue.mock.calls[0]?.[0] as CloudCommandEnvelope;
		expect(JSON.stringify(envelope)).not.toContain("Only the agent");
		expect(envelope).toMatchObject({
			workspaceId: "workspace-1",
			sessionId: "session-1",
			commandId: "message-send:one",
			protocolVersion: 3,
		});
	});
	test("app recreation resumes the accepted identity without enqueueing a second send", async () => {
		const first = sendCloudMessage({
			connection,
			sessionId: SessionId.make("session-1"),
			input: makeTextInput("hello"),
			clientMessageId: MessageId.make("one"),
		});
		void first.result.catch(() => undefined);
		await first.accepted;
		const persisted = state.snapshot.entries[0];
		expect(persisted).toBeDefined();
		await resetMobileClientBus();
		registerMobileEnvironment(connection.key, connection);
		const restored = mobileClientBus().dispatchHandle(
			persisted?.command as ClientCommand,
		);
		void restored.result.catch(() => undefined);
		await restored.accepted;
		expect(state.enqueue).toHaveBeenCalledTimes(1);
		expect(state.live).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(state.watches.length).toBeGreaterThan(0));
		await mobileClientBus().cancelCommand(acceptance.commandId);
		await expect(restored.result).rejects.toMatchObject({ state: "cancelled" });
		expect(state.snapshot.entries).toEqual([]);
		expect(state.snapshot.receipts[0]?.terminalError?.state).toBe("cancelled");
	});
});
