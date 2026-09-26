import {
	CommandIdentityCollisionError,
	commandFingerprint,
} from "@zuse/client-runtime/client-persistence";
import {
	CommandId,
	ComposerInput,
	EnvironmentId,
	MessagesQueueAddRpc,
	MessagesQueueUpdateRpc,
	MessagesSendRpc,
	SessionId,
} from "@zuse/contracts";
import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";

const storage = vi.hoisted(() => ({
	failWrites: 0,
	snapshot: { entries: [], receipts: [] } as {
		entries: unknown[];
		receipts: unknown[];
	},
}));

const rpc = vi.hoisted(() => ({
	cancelPayloads: [] as unknown[],
	answerPayloads: [] as unknown[],
}));

vi.mock("~/offline/cache", () => ({
	deletePath: () => Effect.void,
	messagesPath: () => "/messages/session.json",
	readClientCommandOutbox: () => Effect.succeed(storage.snapshot),
	readMessagesSnapshot: () => Effect.succeed(null),
	writeClientCommandOutbox: (snapshot: typeof storage.snapshot) =>
		storage.failWrites > 0
			? Effect.sync(() => {
					storage.failWrites -= 1;
					throw new Error("simulated storage failure");
				})
			: Effect.sync(() => {
					storage.snapshot = structuredClone(snapshot);
				}),
	writeMessagesSnapshot: () => Effect.void,
}));

vi.mock("~/rpc/connection", () => ({
	getConnectionClient: () =>
		Effect.succeed({
			"session.cancelQuestion": (payload: unknown) =>
				Effect.sync(() => {
					rpc.cancelPayloads.push(payload);
				}),
			"session.answerQuestion": (payload: unknown) =>
				Effect.sync(() => {
					rpc.answerPayloads.push(payload);
				}),
		}),
	isConnectionOnline: () => true,
	reportConnectionFailure: () => undefined,
}));

vi.mock("~/rpc/connection-failures", () => ({
	isRetryableClientError: () => false,
}));

import { cancelQuestion } from "../../../src/rpc/actions";
import {
	MobileCommandOutbox,
	mobileClientBus,
	mobileTerminalCommandRetry,
	rehydrateMobileCommandPayload,
	resetMobileClientBus,
	setMobileClientBusOnline,
} from "../../../src/store/mobile-client-bus";

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
	beforeEach(async () => {
		storage.failWrites = 0;
		storage.snapshot = { entries: [], receipts: [] };
		rpc.cancelPayloads = [];
		rpc.answerPayloads = [];
		await resetMobileClientBus();
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

	test("recovers the persistence lane after a transient storage failure", async () => {
		const outbox = new MobileCommandOutbox();
		storage.failWrites = 1;
		await expect(
			outbox.putOutbox({
				command,
				fingerprint,
				attempts: 1,
				lastAttemptAt: 2,
			}),
		).rejects.toThrow("simulated storage failure");

		const secondCommand = {
			...command,
			commandId: CommandId.make("command-2"),
			payload: { sessionId: "session-2" },
		};
		await expect(
			outbox.putOutbox({
				command: secondCommand,
				fingerprint: commandFingerprint(secondCommand),
				attempts: 1,
				lastAttemptAt: 3,
			}),
		).resolves.toBeUndefined();
		expect(storage.snapshot.entries).toHaveLength(2);
	});

	test.each([
		["messages.send", MessagesSendRpc.payloadSchema, {}],
		[
			"messages.queue.add",
			MessagesQueueAddRpc.payloadSchema,
			{ queueId: "queued-message" },
		],
		[
			"messages.queue.update",
			MessagesQueueUpdateRpc.payloadSchema,
			{ queueId: "queued-message" },
		],
	] as const)("rehydrates %s after restoring the JSON command outbox", async (kind, schema, fields) => {
		const persistedCommand = {
			...command,
			kind,
			payload: {
				commandId: command.commandId,
				sessionId: SessionId.make("durable-session"),
				input: ComposerInput.make({
					text: "durable prompt",
					attachments: [],
					fileRefs: [],
					skillRefs: [],
					annotations: [],
				}),
				...fields,
			},
		};
		const outbox = new MobileCommandOutbox();
		await outbox.putOutbox({
			command: persistedCommand,
			fingerprint: commandFingerprint(persistedCommand),
			attempts: 1,
			lastAttemptAt: 2,
		});
		storage.snapshot = JSON.parse(
			JSON.stringify(storage.snapshot),
		) as typeof storage.snapshot;

		const restored = new MobileCommandOutbox();
		const [entry] = await restored.listOutbox(command.environmentId);
		if (entry === undefined) throw new Error("command was not restored");
		const payload = entry.command.payload as { input: unknown };
		const replayed = rehydrateMobileCommandPayload(kind, payload);

		expect(payload.input).not.toBeInstanceOf(ComposerInput);
		expect(replayed.input).toBeInstanceOf(ComposerInput);
		expect(() => Schema.encodeUnknownSync(schema)(replayed)).not.toThrow();
	});

	test("bounds restored command receipts instead of retaining terminal input history forever", async () => {
		const restoredReceipts = Array.from({ length: 513 }, (_, index) => {
			const restoredCommand = {
				...command,
				commandId: CommandId.make(`terminal-write-${index}`),
				kind: "pty.write",
				payload: { data: "x" },
			};
			return {
				commandId: restoredCommand.commandId,
				fingerprint: commandFingerprint(restoredCommand),
				receivedAt: index,
				result: undefined,
			};
		});
		storage.snapshot = { entries: [], receipts: restoredReceipts };

		const restored = new MobileCommandOutbox();
		expect(
			await restored.findReceipt(CommandId.make("terminal-write-0")),
		).toBeNull();
		expect(
			await restored.findReceipt(CommandId.make("terminal-write-512")),
		).toEqual(restoredReceipts.at(-1));
	});

	test("retries desired-state close, rename, and epoch-qualified restart", () => {
		expect(mobileTerminalCommandRetry("pty.close")).toBe("safe");
		expect(mobileTerminalCommandRetry("pty.rename")).toBe("safe");
		expect(mobileTerminalCommandRetry("pty.restart", true)).toBe("safe");
		expect(mobileTerminalCommandRetry("pty.restart")).toBe("never");
		expect(mobileTerminalCommandRetry("pty.write")).toBe("never");
	});

	test("forwards native offline and online edges to the shared runtime", () => {
		const setOnline = vi.spyOn(mobileClientBus(), "setOnline");

		setMobileClientBusOnline(false);
		setMobileClientBusOnline(true);

		expect(setOnline.mock.calls).toEqual([[false], [true]]);
	});

	test("cancels a question through the durable safe command without encoding an empty answer", async () => {
		const sessionId = SessionId.make("mobile-cancel-question-session");
		const itemId = "mobile-cancel-question-item" as never;
		await Effect.runPromise(
			cancelQuestion({
				connection: { url: "ws://mobile-test" } as never,
				sessionId,
				itemId,
			}),
		);

		expect(rpc.cancelPayloads).toEqual([
			expect.objectContaining({ sessionId, itemId }),
		]);
		expect(rpc.answerPayloads).toEqual([]);
	});
});
