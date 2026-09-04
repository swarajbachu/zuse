import type { ClientCommand } from "@zuse/client-runtime/client-persistence";
import {
	CloudCommandTerminalError,
	CommandIdentityCollisionError,
	commandFingerprint,
	terminalCommandReceipt,
	terminalErrorFromReceipt,
} from "@zuse/client-runtime/client-persistence";
import { CommandId, EnvironmentId, SessionId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	createClientCommandOutbox,
	resetMemoryCommandOutboxForTest,
	upgradePersistedOutboxEntry,
} from "../../src/lib/client-command-outbox.ts";

const environmentId = EnvironmentId.make("outbox-environment");
const commandId = CommandId.make("outbox-command");

const command: ClientCommand = {
	kind: "messages.send",
	commandId,
	environmentId,
	resource: {
		kind: "session-timeline",
		ref: {
			environmentId,
			sessionId: SessionId.make("outbox-session"),
		},
	},
	payload: { text: "persist me" },
	retry: "safe",
	createdAt: 1,
};
const fingerprint = commandFingerprint(command);

describe("renderer command outbox", () => {
	it("persists retry-safe command identity and durable receipts", async () => {
		resetMemoryCommandOutboxForTest();
		const outbox = createClientCommandOutbox();
		await outbox.putOutbox({
			command,
			fingerprint,
			attempts: 1,
			lastAttemptAt: 2,
		});

		await expect(outbox.listOutbox(environmentId)).resolves.toEqual([
			{ command, fingerprint, attempts: 1, lastAttemptAt: 2 },
		]);
		await outbox.removeOutbox(commandId, fingerprint);
		await expect(outbox.listOutbox(environmentId)).resolves.toEqual([]);

		const receipt = {
			commandId,
			fingerprint,
			receivedAt: 3,
			result: "accepted",
		} as const;
		await outbox.putReceipt?.(receipt);
		await expect(outbox.findReceipt?.(commandId)).resolves.toEqual(receipt);
	});

	it("rejects replacing pending or completed identity with a colliding payload", async () => {
		resetMemoryCommandOutboxForTest();
		const outbox = createClientCommandOutbox();
		await outbox.putOutbox({
			command,
			fingerprint,
			attempts: 1,
			lastAttemptAt: 2,
		});
		const collision = { ...command, payload: { text: "different" } };
		const collisionFingerprint = commandFingerprint(collision);

		await expect(
			outbox.putOutbox({
				command: collision,
				fingerprint: collisionFingerprint,
				attempts: 2,
				lastAttemptAt: 3,
			}),
		).rejects.toBeInstanceOf(CommandIdentityCollisionError);
		await expect(
			outbox.completeOutbox?.({
				commandId,
				fingerprint: collisionFingerprint,
				receivedAt: 4,
				result: "wrong",
			}),
		).rejects.toBeInstanceOf(CommandIdentityCollisionError);
		expect(await outbox.listOutbox(environmentId)).toEqual([
			{ command, fingerprint, attempts: 1, lastAttemptAt: 2 },
		]);
	});

	it("atomically replaces a pending row with a typed terminal receipt", async () => {
		resetMemoryCommandOutboxForTest();
		const outbox = createClientCommandOutbox();
		await outbox.putOutbox({
			command,
			fingerprint,
			attempts: 1,
			lastAttemptAt: 2,
		});
		const receipt = terminalCommandReceipt(
			commandId,
			fingerprint,
			new CloudCommandTerminalError(
				"cancelled",
				"cancelled-before-lease",
				"The queued command was cancelled.",
				3,
			),
		);

		await outbox.completeOutbox(receipt);

		await expect(outbox.listOutbox(environmentId)).resolves.toEqual([]);
		const restored = await outbox.findReceipt(commandId);
		expect(restored).toEqual(receipt);
		expect(terminalErrorFromReceipt(restored)).toMatchObject({
			state: "cancelled",
			category: "cancelled-before-lease",
			message: "The queued command was cancelled.",
			occurredAt: 3,
		});
	});

	it("upgrades a legacy IndexedDB outbox row without changing its command identity", () => {
		const upgraded = upgradePersistedOutboxEntry({
			commandId,
			environmentId,
			createdAt: command.createdAt,
			command,
			attempts: 2,
			lastAttemptAt: 3,
		});

		expect(upgraded).toMatchObject({
			command,
			fingerprint,
			attempts: 2,
			lastAttemptAt: 3,
		});
	});
});
