import {
	CommandIdentityCollisionError,
	commandFingerprint,
} from "@zuse/client-runtime/client-persistence";
import { CommandId, EnvironmentId } from "@zuse/contracts";
import { Effect } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";

const storage = vi.hoisted(() => ({
	snapshot: { entries: [], receipts: [] } as {
		entries: unknown[];
		receipts: unknown[];
	},
}));

vi.mock("~/offline/cache", () => ({
	deletePath: () => Effect.void,
	messagesPath: () => "/messages/session.json",
	readClientCommandOutbox: () => Effect.succeed(storage.snapshot),
	readMessagesSnapshot: () => Effect.succeed(null),
	writeClientCommandOutbox: (snapshot: typeof storage.snapshot) =>
		Effect.sync(() => {
			storage.snapshot = structuredClone(snapshot);
		}),
	writeMessagesSnapshot: () => Effect.void,
}));

vi.mock("~/rpc/connection", () => ({
	getConnectionClient: () => Effect.die("unused"),
	isConnectionOnline: () => true,
	reportConnectionFailure: () => undefined,
}));

vi.mock("~/rpc/connection-failures", () => ({
	isRetryableClientError: () => false,
}));

import { MobileCommandOutbox } from "../../../src/store/mobile-client-bus";

const command = {
	kind: "messages.queue.resume",
	commandId: CommandId.make("command-1"),
	environmentId: EnvironmentId.make("environment-1"),
	resource: null,
	payload: { sessionId: "session-1", commandId: "command-1" },
	retry: "safe" as const,
	createdAt: 1,
};
const fingerprint = commandFingerprint(command);

describe("mobile ClientBus command persistence", () => {
	beforeEach(() => {
		storage.snapshot = { entries: [], receipts: [] };
	});

	test("survives a runtime recreation until the receipt is stored", async () => {
		const first = new MobileCommandOutbox();
		await first.putOutbox({
			command,
			fingerprint,
			attempts: 1,
			lastAttemptAt: 2,
		});

		const restored = new MobileCommandOutbox();
		expect(await restored.listOutbox(command.environmentId)).toEqual([
			{ command, fingerprint, attempts: 1, lastAttemptAt: 2 },
		]);

		const receipt = {
			commandId: command.commandId,
			fingerprint,
			receivedAt: 3,
			result: undefined,
		};
		await restored.completeOutbox(receipt);
		expect(await restored.listOutbox(command.environmentId)).toEqual([]);
		expect(await restored.findReceipt(command.commandId)).toEqual(receipt);
	});

	test("rejects a restored command ID collision without replacing the original", async () => {
		const first = new MobileCommandOutbox();
		await first.putOutbox({
			command,
			fingerprint,
			attempts: 1,
			lastAttemptAt: 2,
		});
		const restored = new MobileCommandOutbox();
		const collision = { ...command, payload: { sessionId: "other-session" } };

		await expect(
			restored.putOutbox({
				command: collision,
				fingerprint: commandFingerprint(collision),
				attempts: 2,
				lastAttemptAt: 3,
			}),
		).rejects.toBeInstanceOf(CommandIdentityCollisionError);
		expect(await restored.listOutbox(command.environmentId)).toEqual([
			{ command, fingerprint, attempts: 1, lastAttemptAt: 2 },
		]);
	});
});
