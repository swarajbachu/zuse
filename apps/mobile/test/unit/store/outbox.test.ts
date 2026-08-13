import { CommandId, SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { connectionSessionKey } from "../../../src/lib/session-key";

const runtime = vi.hoisted(() => ({
	snapshot: null as { items: readonly unknown[] } | null,
	writes: [] as Array<{ items: readonly unknown[] }>,
	deletes: [] as string[],
	commands: [] as unknown[],
}));

vi.mock("~/offline/cache", () => ({
	deletePath: (path: string) =>
		Effect.sync(() => {
			runtime.deletes.push(path);
		}),
	outboxPath: (connKey: string, sessionId: string) =>
		`/outbox/${connKey}/${sessionId}.json`,
	readOutboxSnapshot: () => Effect.succeed(runtime.snapshot),
	writeOutboxSnapshot: (
		_connKey: string,
		_sessionId: string,
		snapshot: never,
	) =>
		Effect.sync(() => {
			runtime.writes.push(snapshot);
		}),
}));

vi.mock("~/rpc/actions", () => ({
	makeTextInput: (
		text: string,
		_attachments: readonly unknown[],
		asGoal?: boolean,
	) => ({ text, asGoal }),
}));

vi.mock("~/store/mobile-client-bus", () => ({
	stageMobileSessionCommand: (command: unknown) => {
		runtime.commands.push(command);
		return Promise.resolve();
	},
	sessionCommandContext: () => ({
		environmentId: "environment-1",
		resource: {
			kind: "session-timeline",
			ref: { environmentId: "environment-1", sessionId: "session-1" },
		},
	}),
}));

import {
	cancelOutboxMessage,
	enqueueOutboxMessage,
	hydrateOutbox,
	queuedBySessionAtom,
	resetOutboxRuntime,
	submitOutboxDrafts,
	updateOutboxMessage,
} from "../../../src/store/outbox";
import { appAtomRegistry } from "../../../src/store/registry";

const sessionId = SessionId.make("session-1");
const key = connectionSessionKey("conn", sessionId);
const options = { host: "127.0.0.1", port: 4000 } as never;

describe("mobile offline drafts", () => {
	beforeEach(async () => {
		await resetOutboxRuntime();
		runtime.snapshot = null;
		runtime.writes = [];
		runtime.deletes = [];
		runtime.commands = [];
	});

	test("keeps genuinely unsent drafts editable and cancellable", async () => {
		await enqueueOutboxMessage("conn", sessionId, "first", true);
		const [draft] = appAtomRegistry.get(queuedBySessionAtom)[key] ?? [];
		expect(draft).toMatchObject({ text: "first", asGoal: true });

		await updateOutboxMessage(
			"conn",
			sessionId,
			draft?.clientId ?? "",
			"edited",
		);
		expect(appAtomRegistry.get(queuedBySessionAtom)[key]?.[0]?.text).toBe(
			"edited",
		);

		await cancelOutboxMessage("conn", sessionId, draft?.clientId ?? "");
		expect(appAtomRegistry.get(queuedBySessionAtom)[key]).toEqual([]);
		expect(runtime.deletes).toEqual(["/outbox/conn/session-1.json"]);
	});

	test("hands each draft once to a stable ClientBus command", async () => {
		runtime.snapshot = {
			items: [
				{
					clientId: "offline-queue:stable",
					text: "resume me",
					asGoal: false,
					createdAt: 42,
				},
			],
		};
		await hydrateOutbox("conn", sessionId);
		await submitOutboxDrafts("conn", options, sessionId);

		expect(runtime.commands).toEqual([
			expect.objectContaining({
				kind: "messages.queue.add",
				commandId: CommandId.make("offline-queue:stable"),
				createdAt: 42,
				payload: expect.objectContaining({
					commandId: CommandId.make("offline-queue:stable"),
					queueId: "offline-queue:stable",
				}),
			}),
		]);
		expect(appAtomRegistry.get(queuedBySessionAtom)[key]).toEqual([]);
		expect(runtime.deletes).toEqual(["/outbox/conn/session-1.json"]);
	});
});
