import { commandFingerprint } from "@zuse/client-runtime/client-persistence";
import { CommandId, EnvironmentId } from "@zuse/contracts";
import { Effect } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";

const disk = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-file-system/legacy", () => ({
	documentDirectory: "file:///test/",
	makeDirectoryAsync: vi.fn(async () => undefined),
	writeAsStringAsync: vi.fn(async (path: string, value: string) => {
		disk.set(path, value);
	}),
	getInfoAsync: vi.fn(async (path: string) => ({ exists: disk.has(path) })),
	readAsStringAsync: vi.fn(async (path: string) => disk.get(path)),
}));

import {
	readClientCommandOutbox,
	writeClientCommandOutbox,
} from "../../../src/offline/cache";

describe("mobile durable cloud command disk codec", () => {
	beforeEach(() => disk.clear());
	test("round-trips opaque envelope, acceptance, status, and terminal receipt", async () => {
		const command = {
			kind: "messages.send",
			commandId: CommandId.make("message-send:one"),
			environmentId: EnvironmentId.make("workspace-1"),
			resource: null,
			payload: { text: "hello" },
			retry: "safe" as const,
			createdAt: 1,
			awaitResourceReflection: true,
		};
		const fingerprint = commandFingerprint(command);
		const snapshot = {
			entries: [
				{
					command,
					fingerprint,
					attempts: 1,
					lastAttemptAt: 2,
					encryptedEnvelope: {
						ciphertext: "opaque",
						commandId: command.commandId,
					},
					acceptance: {
						workspaceId: "workspace-1",
						commandId: command.commandId,
						acceptedRevision: 3,
					},
					deliveryStatus: { state: "waiting-for-runtime", everLeased: false },
				},
			],
			receipts: [
				{
					commandId: CommandId.make("finished"),
					fingerprint,
					result: null,
					receivedAt: 4,
					terminalError: {
						message: "No replay",
						state: "outcome-unknown",
						category: "runtime-storage-replaced",
					},
				},
			],
		};
		// Storage is deliberately opaque; transport schemas validate before replay.
		await Effect.runPromise(writeClientCommandOutbox(snapshot as never));
		expect(await Effect.runPromise(readClientCommandOutbox())).toEqual(
			snapshot,
		);
	});
	test("corrupt accepted state is not silently converted to an empty outbox", async () => {
		disk.set(
			"file:///test/zuse-cache/client-command-outbox.json",
			'{"entries":',
		);
		await expect(
			Effect.runPromise(readClientCommandOutbox()),
		).rejects.toThrow();
		expect(disk.size).toBe(1);
	});
	test("malformed persisted command identity stops recovery instead of dropping a row", async () => {
		disk.set(
			"file:///test/zuse-cache/client-command-outbox.json",
			JSON.stringify({
				entries: [{ command: null, acceptance: { commandId: "accepted" } }],
				receipts: [],
			}),
		);
		await expect(Effect.runPromise(readClientCommandOutbox())).rejects.toThrow(
			"Invalid persisted command identity",
		);
	});
});
