import type {
	ResourceDriverContext,
	ResourceDriverUpdate,
} from "@zuse/client-runtime/client-bus";
import { ClientBus } from "@zuse/client-runtime/client-bus";
import type {
	ClientCommand,
	CommandOutbox,
	OutboxEntry,
} from "@zuse/client-runtime/client-persistence";
import { commandFingerprint } from "@zuse/client-runtime/client-persistence";
import type { ResourceKey } from "@zuse/client-runtime/resource-ref";
import { makeResourceKey } from "@zuse/client-runtime/resource-ref";
import type { TerminalResourceState } from "@zuse/client-runtime/terminal-resource";
import {
	CommandId,
	EnvironmentId,
	type PtyEvent,
	PtyId,
	SessionId,
} from "@zuse/contracts";
import { Effect, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
	makeTerminalResourceDriver,
	type TerminalDriverClient,
	terminalInputCommand,
	terminalResourceKey,
} from "../../src/lib/terminal-client-bus.ts";

const waitUntil = async (predicate: () => boolean): Promise<void> => {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not reached");
};

const environmentId = EnvironmentId.make("terminal-environment");
const terminalId = PtyId.make("terminal-1");
const key = terminalResourceKey({ environmentId, terminalId });

const makeContext = (
	output: Queue.Queue<typeof PtyEvent.Type>,
	write: (bytes: string) => Promise<void>,
	isCurrent: () => boolean = () => true,
) => {
	let view: TerminalResourceState | null = null;
	let cursor: { epoch: string; version: number } | null = null;
	const updates: ResourceDriverUpdate<TerminalResourceState>[] = [];
	const client = {
		"pty.output": () => Stream.fromQueue(output),
	};
	const context: ResourceDriverContext<
		TerminalDriverClient,
		TerminalResourceState
	> = {
		key,
		client: client as TerminalDriverClient,
		generation: 1,
		data: null,
		cursor: null,
		snapshot: () => null,
		emit: (update) => {
			updates.push(update);
			if (update.data !== undefined) view = update.data;
			if (update.cursor !== undefined) cursor = update.cursor;
			return true;
		},
		isCurrent,
	};
	const driver = makeTerminalResourceDriver({
		sinkFor: () => ({
			write,
			exited: async () => undefined,
		}),
		reportConnectionFailure: () => undefined,
	});
	return {
		context,
		driver,
		updates,
		view: () => view,
		cursor: () => cursor,
	};
};

describe("terminal ClientBus adapter", () => {
	it("shares one environment runtime and terminal stream across consumers", async () => {
		const output = Effect.runSync(Queue.unbounded<typeof PtyEvent.Type>());
		let resolves = 0;
		let terminalStreams = 0;
		let timelineStreams = 0;
		const client = {
			"pty.output": () => {
				terminalStreams += 1;
				return Stream.fromQueue(output);
			},
		};
		const bus = new ClientBus({
			resolver: {
				resolve: () => {
					resolves += 1;
					return Effect.succeed({
						client,
						dispose: async () => undefined,
					});
				},
			},
			driverFor: (resource) => {
				if (resource.kind === "terminal") {
					return makeTerminalResourceDriver({
						sinkFor: () => ({
							write: async () => undefined,
							exited: async () => undefined,
						}),
						reportConnectionFailure: () => undefined,
					}) as never;
				}
				if (resource.kind === "session-timeline") {
					return {
						start: () => {
							timelineStreams += 1;
						},
						stop: () => undefined,
					};
				}
				return null;
			},
		});
		const timelineKey = makeResourceKey<{ head: number }>("session-timeline", {
			environmentId,
			sessionId: SessionId.make("session-1"),
		});
		const firstTerminal = bus.retain(key, { activation: "connect" });
		const secondTerminal = bus.retain(key, { activation: "connect" });
		const timeline = bus.retain(timelineKey, { activation: "connect" });
		await waitUntil(() => terminalStreams === 1 && timelineStreams === 1);
		expect(resolves).toBe(1);
		expect(bus.connection(environmentId)).toMatchObject({
			phase: "connected",
			generation: 1,
		});
		firstTerminal.release();
		expect(terminalStreams).toBe(1);
		secondTerminal.release();
		timeline.release();
		await bus.dispose();
	});

	it("writes bytes directly before advancing its canonical cursor", async () => {
		const output = Effect.runSync(Queue.unbounded<typeof PtyEvent.Type>());
		let completeWrite: (() => void) | null = null;
		const writes: string[] = [];
		const harness = makeContext(
			output,
			(bytes) =>
				new Promise<void>((resolve) => {
					writes.push(bytes);
					completeWrite = resolve;
				}),
		);
		harness.driver.start(harness.context);
		Queue.offerUnsafe(output, { _tag: "data", sequence: 1, bytes: "one" });
		await waitUntil(() => writes.length === 1);
		expect(harness.cursor()?.version).toBe(0);
		const finishWrite = completeWrite as (() => void) | null;
		finishWrite?.();
		await waitUntil(() => harness.cursor()?.version === 1);
		expect(harness.view()).toMatchObject({ outputSequence: 1 });
		harness.driver.stop();
	});

	it("recovers once from a live sequence gap using the last accepted cursor", async () => {
		const output = Effect.runSync(Queue.unbounded<typeof PtyEvent.Type>());
		const afterSequences: Array<number | undefined> = [];
		const writes: string[] = [];
		let view: TerminalResourceState | null = null;
		let cursor: { epoch: string; version: number } | null = null;
		const client = {
			"pty.output": ({ afterSequence }: { afterSequence?: number }) => {
				afterSequences.push(afterSequence);
				return Stream.fromQueue(output);
			},
		};
		const driver = makeTerminalResourceDriver({
			sinkFor: () => ({
				write: async (bytes) => {
					writes.push(bytes);
				},
				exited: async () => undefined,
			}),
			reportConnectionFailure: () => undefined,
		});
		driver.start({
			key,
			client: client as never,
			generation: 1,
			data: null,
			cursor: null,
			snapshot: () => null,
			emit: (update) => {
				if (update.data !== undefined) view = update.data;
				if (update.cursor !== undefined) cursor = update.cursor;
				return true;
			},
			isCurrent: () => true,
		});
		Queue.offerUnsafe(output, { _tag: "data", sequence: 1, bytes: "one" });
		await waitUntil(() => cursor?.version === 1);
		Queue.offerUnsafe(output, { _tag: "data", sequence: 3, bytes: "three" });
		await waitUntil(() => afterSequences.length === 2);
		expect(afterSequences).toEqual([0, 1]);
		expect(writes).toEqual(["one"]);
		expect(view).toMatchObject({
			phase: "reconnecting",
			outputSequence: 1,
		});
		driver.stop();
	});

	it("never makes terminal input eligible for durable outbox replay", async () => {
		const command = terminalInputCommand({
			ref: { environmentId, terminalId },
			data: "ls\r",
			commandId: CommandId.make("terminal-input"),
		});
		expect(command).toMatchObject({
			kind: "pty.write",
			retry: "never",
			environmentId,
			resource: key,
		});

		const persisted: OutboxEntry[] = [];
		const outbox: CommandOutbox = {
			putOutbox: async (entry) => {
				persisted.push(entry);
			},
			removeOutbox: async () => undefined,
			listOutbox: async () => persisted,
		};
		const persistIfSafe = async (candidate: ClientCommand): Promise<void> => {
			if (candidate.retry !== "safe") return;
			await outbox.putOutbox({
				command: candidate,
				fingerprint: commandFingerprint(candidate),
				attempts: 0,
				lastAttemptAt: null,
			});
		};
		await persistIfSafe(command);
		expect(await outbox.listOutbox()).toEqual([]);
	});

	it("drops output from an obsolete connection generation before the byte sink", async () => {
		const output = Effect.runSync(Queue.unbounded<typeof PtyEvent.Type>());
		const writes: string[] = [];
		let current = true;
		const harness = makeContext(
			output,
			async (bytes) => {
				writes.push(bytes);
			},
			() => current,
		);
		harness.driver.start(harness.context);
		current = false;
		Queue.offerUnsafe(output, {
			_tag: "data",
			sequence: 1,
			bytes: "stale-generation",
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(writes).toEqual([]);
		expect(harness.cursor()?.version).toBe(0);
		harness.driver.stop();
	});

	it("uses explicit environment-qualified terminal keys", () => {
		const other = terminalResourceKey({
			environmentId: EnvironmentId.make("other-environment"),
			terminalId,
		});
		expect(other).not.toEqual(key);
		expect((key as ResourceKey).ref.environmentId).toBe(environmentId);
	});
});
