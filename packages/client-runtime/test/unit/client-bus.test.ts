import { CommandId, EnvironmentId, SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ClientBus, type ResourceDriverContext } from "../../src/client-bus.ts";
import type {
	ClientPersistence,
	CommandFingerprint,
	CommandReceipt,
	OutboxEntry,
	PersistedResource,
} from "../../src/client-persistence.ts";
import {
	CommandIdentityCollisionError,
	commandFingerprint,
} from "../../src/client-persistence.ts";
import type { EnvironmentResolver } from "../../src/environment-runtime.ts";
import {
	makeResourceKey,
	type ResourceKey,
	resourceKeyId,
} from "../../src/resource-ref.ts";

type Client = { readonly id: number };
type Timeline = { readonly text: string };

const deferred = <Value>() => {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((onResolve) => {
		resolve = onResolve;
	});
	return { promise, resolve };
};

const waitUntil = async (predicate: () => boolean): Promise<void> => {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error("condition was not reached");
};

const environmentId = EnvironmentId.make("environment-1");
const timelineKey = makeResourceKey<Timeline>("session-timeline", {
	environmentId,
	sessionId: SessionId.make("session-1"),
});
const otherTimelineKey = makeResourceKey<Timeline>("session-timeline", {
	environmentId,
	sessionId: SessionId.make("session-2"),
});

const immediateResolver = (
	onResolve: (activation: "connect" | "wake") => void = () => undefined,
): EnvironmentResolver<Client> => ({
	resolve: (_environmentId, activation) => {
		onResolve(activation);
		return Effect.succeed({
			client: { id: 1 },
			dispose: async () => undefined,
		});
	},
});

class MemoryPersistence implements ClientPersistence {
	readonly resources = new Map<string, PersistedResource<unknown>>();
	readonly outbox = new Map<CommandId, OutboxEntry>();
	readonly receipts = new Map<CommandId, CommandReceipt>();
	loadGate: Promise<PersistedResource<unknown> | null> | null = null;

	async loadResource<Data>(
		key: ResourceKey<Data>,
	): Promise<PersistedResource<Data> | null> {
		return (this.loadGate ??
			this.resources.get(resourceKeyId(key)) ??
			null) as PersistedResource<Data> | null;
	}

	async saveResource<Data>(
		key: ResourceKey<Data>,
		value: PersistedResource<Data>,
	): Promise<void> {
		this.resources.set(resourceKeyId(key), value);
	}

	async removeResource(key: ResourceKey<unknown>): Promise<void> {
		this.resources.delete(resourceKeyId(key));
	}

	async putOutbox(entry: OutboxEntry): Promise<void> {
		const existing = this.outbox.get(entry.command.commandId);
		if (existing !== undefined && existing.fingerprint !== entry.fingerprint) {
			throw new CommandIdentityCollisionError(
				entry.command.commandId,
				existing.fingerprint,
				entry.fingerprint,
			);
		}
		this.outbox.set(entry.command.commandId, entry);
	}

	async removeOutbox(
		commandId: CommandId,
		fingerprint: CommandFingerprint,
	): Promise<void> {
		const existing = this.outbox.get(commandId);
		if (existing !== undefined && existing.fingerprint !== fingerprint) {
			throw new CommandIdentityCollisionError(
				commandId,
				existing.fingerprint,
				fingerprint,
			);
		}
		this.outbox.delete(commandId);
	}

	async findReceipt(commandId: CommandId) {
		return this.receipts.get(commandId) ?? null;
	}

	async putReceipt(receipt: CommandReceipt): Promise<void> {
		const existing = this.receipts.get(receipt.commandId);
		if (
			existing !== undefined &&
			existing.fingerprint !== receipt.fingerprint
		) {
			throw new CommandIdentityCollisionError(
				receipt.commandId,
				existing.fingerprint,
				receipt.fingerprint,
			);
		}
		this.receipts.set(receipt.commandId, receipt);
	}

	async completeOutbox(receipt: CommandReceipt): Promise<void> {
		const pending = this.outbox.get(receipt.commandId);
		if (pending !== undefined && pending.fingerprint !== receipt.fingerprint) {
			throw new CommandIdentityCollisionError(
				receipt.commandId,
				pending.fingerprint,
				receipt.fingerprint,
			);
		}
		await this.putReceipt(receipt);
		this.outbox.delete(receipt.commandId);
	}

	async listOutbox(
		filterEnvironmentId?: EnvironmentId,
	): Promise<readonly OutboxEntry[]> {
		return [...this.outbox.values()].filter(
			(entry) =>
				filterEnvironmentId === undefined ||
				entry.command.environmentId === filterEnvironmentId,
		);
	}
}

describe("ClientBus", () => {
	it("shares one environment resolution and one keyed driver across retainers", async () => {
		let resolves = 0;
		let starts = 0;
		let cleanup = 0;
		let context: ResourceDriverContext<Client, Timeline> | null = null;
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(() => {
				resolves += 1;
			}),
			driverFor: () => ({
				start: (next) => {
					starts += 1;
					context = next as ResourceDriverContext<Client, Timeline>;
				},
				stop: () => {
					cleanup += 1;
				},
			}),
		});

		const first = bus.retain(timelineKey, { activation: "connect" });
		const second = bus.retain(timelineKey, { activation: "connect" });
		await waitUntil(() => starts === 1);
		expect(resolves).toBe(1);
		expect(context).not.toBeNull();

		const observed: string[] = [];
		const unsubscribe = bus.subscribe(timelineKey, (view) => {
			if (view.data !== null) observed.push(view.data.text);
		});
		const activeContext = context as unknown as ResourceDriverContext<
			Client,
			Timeline
		>;
		activeContext.emit({
			data: { text: "live" },
			cursor: { epoch: "epoch-1", version: 1 },
			sync: "live",
		});
		expect(bus.snapshot(timelineKey)).toMatchObject({
			data: { text: "live" },
			origin: "runtime",
			connection: "connected",
			sync: "live",
		});
		expect(observed).toEqual(["live"]);

		first.release();
		expect(cleanup).toBe(0);
		second.release();
		expect(cleanup).toBe(1);
		unsubscribe();
		await bus.dispose();
	});

	it("does not let a later cache-only lease weaken a live shared resource", async () => {
		let resolves = 0;
		let disposals = 0;
		let starts = 0;
		const bus = new ClientBus<Client>({
			resolver: {
				resolve: () =>
					Effect.sync(() => ({
						client: { id: ++resolves },
						dispose: async () => {
							disposals += 1;
						},
					})),
			},
			driverFor: () => ({
				start: () => {
					starts += 1;
				},
				stop: () => undefined,
			}),
		});
		const live = bus.retain(timelineKey, { activation: "wake" });
		await waitUntil(() => starts === 1);
		const cached = bus.retain(timelineKey, { activation: "cache-only" });
		await Promise.resolve();

		expect(bus.connection(environmentId).phase).toBe("connected");
		expect(resolves).toBe(1);
		expect(disposals).toBe(0);
		expect(starts).toBe(1);

		cached.release();
		live.release();
		await bus.dispose();
	});

	it("hydrates cache-only resources without opening a connection or driver", async () => {
		const persistence = new MemoryPersistence();
		persistence.resources.set(resourceKeyId(timelineKey), {
			data: { text: "cached" },
			cursor: { epoch: "cache", version: 4 },
			storedAt: 1,
		});
		let resolves = 0;
		let starts = 0;
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(() => {
				resolves += 1;
			}),
			persistence,
			driverFor: () => ({
				start: () => {
					starts += 1;
				},
				stop: () => undefined,
			}),
		});

		const lease = bus.retain(timelineKey, { activation: "cache-only" });
		await waitUntil(() => bus.snapshot(timelineKey).data !== null);
		expect(bus.snapshot(timelineKey)).toMatchObject({
			data: { text: "cached" },
			origin: "cache",
			sync: "cached",
			connection: "dormant",
		});
		expect(resolves).toBe(0);
		expect(starts).toBe(0);

		lease.activate("connect");
		await waitUntil(() => starts === 1);
		expect(resolves).toBe(1);
		lease.activate("cache-only");
		expect(bus.snapshot(timelineKey).sync).toBe("cached");
		lease.release();
		await bus.dispose();
	});

	it("downgrades shared runtime demand and stops only the released resource streams", async () => {
		let resolves = 0;
		let disposals = 0;
		const starts = new Map<string, number>();
		const stops = new Map<string, number>();
		const bus = new ClientBus<Client>({
			resolver: {
				resolve: () =>
					Effect.sync(() => ({
						client: { id: ++resolves },
						dispose: async () => {
							disposals += 1;
						},
					})),
			},
			driverFor: (key) => {
				const id = resourceKeyId(key);
				return {
					start: () => {
						starts.set(id, (starts.get(id) ?? 0) + 1);
					},
					stop: () => {
						stops.set(id, (stops.get(id) ?? 0) + 1);
					},
				};
			},
		});
		const firstId = resourceKeyId(timelineKey);
		const secondId = resourceKeyId(otherTimelineKey);
		const cached = bus.retain(timelineKey, { activation: "cache-only" });
		const live = bus.retain(timelineKey, { activation: "wake" });
		const other = bus.retain(otherTimelineKey, { activation: "connect" });
		await waitUntil(
			() => starts.get(firstId) === 1 && starts.get(secondId) === 1,
		);
		expect(resolves).toBe(1);

		live.release();
		expect(stops.get(firstId)).toBe(1);
		expect(stops.get(secondId) ?? 0).toBe(0);
		expect(bus.connection(environmentId).phase).toBe("connected");

		other.activate("cache-only");
		await waitUntil(() => disposals === 1);
		expect(stops.get(secondId)).toBe(1);
		expect(bus.connection(environmentId).phase).toBe("dormant");
		expect(resolves).toBe(1);

		other.activate("connect");
		await waitUntil(() => starts.get(secondId) === 2);
		expect(resolves).toBe(2);
		expect(starts.get(firstId)).toBe(1);

		other.release();
		cached.release();
		await bus.dispose();
	});

	it("fences regressing cursors and old driver generations", async () => {
		const contexts: ResourceDriverContext<Client, Timeline>[] = [];
		let clientId = 0;
		const bus = new ClientBus<Client>({
			resolver: {
				resolve: () =>
					Effect.sync(() => ({
						client: { id: ++clientId },
						dispose: async () => undefined,
					})),
			},
			driverFor: () => ({
				start: (context) => {
					contexts.push(context as ResourceDriverContext<Client, Timeline>);
				},
				stop: () => undefined,
			}),
		});
		bus.retain(timelineKey, { activation: "connect" });
		await waitUntil(() => contexts.length === 1);
		const first = contexts[0];
		first?.emit({
			data: { text: "v2" },
			cursor: { epoch: "epoch-1", version: 2 },
			sync: "live",
		});
		expect(
			first?.emit({
				data: { text: "v1" },
				cursor: { epoch: "epoch-1", version: 1 },
			}),
		).toBe(false);
		expect(
			first?.emit({
				data: { text: "wrong epoch" },
				cursor: { epoch: "epoch-2", version: 1 },
			}),
		).toBe(false);
		expect(
			first?.emit({
				data: { text: "restored" },
				cursor: { epoch: "epoch-2", version: 1 },
				resetEpoch: true,
			}),
		).toBe(true);
		expect(
			first?.emit({
				data: { text: "bounded reset" },
				cursor: { epoch: "epoch-2", version: 0 },
				resetEpoch: true,
			}),
		).toBe(true);

		const generation = bus.connection(environmentId).generation;
		bus.reportConnectionFault(
			environmentId,
			{ phase: "offline", message: "closed" },
			generation,
		);
		const reconnectLease = bus.retain(timelineKey, { activation: "wake" });
		await waitUntil(() => contexts.length === 2);

		expect(
			first?.emit({
				data: { text: "late old generation" },
				cursor: { epoch: "epoch-2", version: 2 },
			}),
		).toBe(false);
		expect(first?.isCurrent()).toBe(false);
		expect(bus.snapshot(timelineKey).data).toEqual({ text: "bounded reset" });
		reconnectLease.release();
		await bus.dispose();
	});

	it("fences and persists side-request data without moving its stream cursor", async () => {
		const persistence = new MemoryPersistence();
		let context: ResourceDriverContext<Client, Timeline> | null = null;
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			driverFor: () => ({
				start: (next) => {
					context = next as ResourceDriverContext<Client, Timeline>;
				},
				stop: () => undefined,
			}),
		});
		bus.retain(timelineKey, { activation: "connect" });
		await waitUntil(() => context !== null);
		(context as unknown as ResourceDriverContext<Client, Timeline>).emit({
			data: { text: "current" },
			cursor: { epoch: "epoch-1", version: 7 },
			sync: "live",
		});
		const before = bus.snapshot(timelineKey);

		expect(
			bus.update(timelineKey, {
				expectedGeneration: before.generation,
				expectedCursor: before.cursor,
				update: () => ({ text: "with older page" }),
				persist: true,
			}),
		).toBe(true);
		expect(bus.snapshot(timelineKey)).toMatchObject({
			data: { text: "with older page" },
			cursor: { epoch: "epoch-1", version: 7 },
		});
		expect(
			bus.update(timelineKey, {
				expectedGeneration: before.generation + 1,
				expectedCursor: before.cursor,
				update: () => ({ text: "wrong generation" }),
			}),
		).toBe(false);
		expect(
			bus.update(timelineKey, {
				expectedGeneration: before.generation,
				expectedCursor: { epoch: "epoch-1", version: 6 },
				update: () => ({ text: "stale cursor" }),
			}),
		).toBe(false);

		await bus.dispose();
		expect(persistence.resources.get(resourceKeyId(timelineKey))).toMatchObject(
			{
				data: { text: "with older page" },
				cursor: { epoch: "epoch-1", version: 7 },
			},
		);
	});

	it("applies optimistic overlays without moving the durable cursor", async () => {
		let context: ResourceDriverContext<Client, Timeline> | null = null;
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			driverFor: () => ({
				start: (next) => {
					context = next as ResourceDriverContext<Client, Timeline>;
				},
				stop: () => undefined,
			}),
		});
		bus.retain(timelineKey, { activation: "connect" });
		await waitUntil(() => context !== null);
		(context as unknown as ResourceDriverContext<Client, Timeline>).emit({
			data: { text: "durable" },
			cursor: { epoch: "epoch", version: 3 },
			sync: "live",
		});

		expect(
			bus.overlay(timelineKey, {
				update: (data) => ({ text: `${data.text} + optimistic` }),
			}),
		).toBe(true);
		expect(bus.snapshot(timelineKey)).toMatchObject({
			data: { text: "durable + optimistic" },
			cursor: { epoch: "epoch", version: 3 },
			origin: "runtime",
		});
		await bus.dispose();
	});

	it("seeds a new canonical cell from its first optimistic overlay", () => {
		const bus = new ClientBus<Client>({ resolver: immediateResolver() });
		bus.snapshot(timelineKey);

		expect(
			bus.overlay(timelineKey, {
				initialData: { text: "" },
				update: () => ({ text: "first prompt" }),
			}),
		).toBe(true);
		expect(bus.snapshot(timelineKey)).toMatchObject({
			data: { text: "first prompt" },
			origin: "runtime",
			cursor: null,
		});
	});

	it("never lets delayed cache hydration overwrite runtime data", async () => {
		const persistence = new MemoryPersistence();
		const cacheGate = deferred<PersistedResource<unknown> | null>();
		persistence.loadGate = cacheGate.promise;
		let context: ResourceDriverContext<Client, Timeline> | null = null;
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			driverFor: () => ({
				start: (next) => {
					context = next as ResourceDriverContext<Client, Timeline>;
				},
				stop: () => undefined,
			}),
		});
		bus.retain(timelineKey, { activation: "connect" });
		await waitUntil(() => context !== null);
		const activeContext = context as unknown as ResourceDriverContext<
			Client,
			Timeline
		>;
		activeContext.emit({
			data: { text: "runtime" },
			cursor: { epoch: "epoch", version: 5 },
			sync: "live",
		});
		cacheGate.resolve({
			data: { text: "old cache" },
			cursor: { epoch: "epoch", version: 3 },
			storedAt: 1,
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(bus.snapshot(timelineKey)).toMatchObject({
			data: { text: "runtime" },
			origin: "runtime",
			cursor: { epoch: "epoch", version: 5 },
		});
		await bus.dispose();
	});

	it("persists safe commands before send and removes them after receipt", async () => {
		const persistence = new MemoryPersistence();
		const commandId = CommandId.make("command-1");
		let sawPersistedBeforeExecute = false;
		let executions = 0;
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			commandExecutor: {
				execute: async (_client, command) => {
					executions += 1;
					sawPersistedBeforeExecute = persistence.outbox.has(command.commandId);
					return {
						commandId: command.commandId,
						receivedAt: 2,
						result: "done",
					};
				},
			},
		});
		const command = {
			kind: "messages.send",
			commandId,
			environmentId,
			resource: timelineKey,
			payload: { text: "hello" },
			retry: "safe" as const,
			createdAt: 1,
		};

		const first = bus.dispatch(command);
		const duplicate = bus.dispatch(command);
		expect(duplicate).toBe(first);
		await expect(first).resolves.toMatchObject({
			commandId,
			result: "done",
		});
		expect(sawPersistedBeforeExecute).toBe(true);
		expect(persistence.outbox.size).toBe(0);
		expect(bus.snapshot(timelineKey).pendingCommands).toEqual([]);
		const replayedReceipt = await bus.dispatch(command);
		expect(replayedReceipt).toMatchObject({ commandId, result: "done" });
		expect(executions).toBe(1);
		await bus.dispose();
	});

	it("rejects an in-flight command ID collision before executing another payload", async () => {
		const persistence = new MemoryPersistence();
		const gate = deferred<void>();
		let executions = 0;
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			commandExecutor: {
				execute: async (_client, command) => {
					executions += 1;
					await gate.promise;
					return {
						commandId: command.commandId,
						receivedAt: 2,
						result: "accepted",
					};
				},
			},
		});
		const commandId = CommandId.make("command-in-flight-collision");
		const first = bus.dispatch({
			kind: "messages.send",
			commandId,
			environmentId,
			resource: timelineKey,
			payload: { text: "original" },
			retry: "safe",
			createdAt: 1,
		});
		await waitUntil(() => executions === 1);

		await expect(
			bus.dispatch({
				kind: "messages.send",
				commandId,
				environmentId,
				resource: timelineKey,
				payload: { text: "collision" },
				retry: "safe",
				createdAt: 99,
			}),
		).rejects.toBeInstanceOf(CommandIdentityCollisionError);
		expect(executions).toBe(1);

		gate.resolve();
		await first;
		await bus.dispose();
	});

	it("rejects mutation of a queued command before execution", async () => {
		const activationGate = deferred<void>();
		let executions = 0;
		const bus = new ClientBus<Client>({
			resolver: {
				resolve: () =>
					Effect.promise(async () => {
						await activationGate.promise;
						return {
							client: { id: 1 },
							dispose: async () => undefined,
						};
					}),
			},
			commandExecutor: {
				execute: async (_client, command) => {
					executions += 1;
					return {
						commandId: command.commandId,
						receivedAt: 2,
						result: null,
					};
				},
			},
		});
		const payload = { text: "original" };
		const command = {
			kind: "messages.send",
			commandId: CommandId.make("command-mutated-before-execution"),
			environmentId,
			resource: timelineKey,
			payload,
			retry: "never" as const,
			createdAt: 1,
		};

		const pending = bus.dispatch(command);
		payload.text = "mutated";
		activationGate.resolve();

		await expect(pending).rejects.toBeInstanceOf(CommandIdentityCollisionError);
		expect(executions).toBe(0);
		await bus.dispose();
	});

	it("rejects a persisted receipt collision across environment, resource, kind, and payload", async () => {
		const persistence = new MemoryPersistence();
		const commandId = CommandId.make("command-persisted-collision");
		const original = {
			kind: "messages.send",
			commandId,
			environmentId,
			resource: timelineKey,
			payload: { nested: { a: 1, b: 2 } },
			retry: "safe" as const,
			createdAt: 1,
		};
		const fingerprint = commandFingerprint(original);
		await persistence.putReceipt({
			commandId,
			fingerprint,
			receivedAt: 2,
			result: "original",
		});
		let executions = 0;
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			commandExecutor: {
				execute: async (_client, command) => {
					executions += 1;
					return { commandId: command.commandId, receivedAt: 3, result: null };
				},
			},
		});

		// Canonical key ordering and local scheduling time do not alter identity.
		await expect(
			bus.dispatch({
				...original,
				payload: { nested: { b: 2, a: 1 } },
				createdAt: 100,
			}),
		).resolves.toMatchObject({ result: "original", fingerprint });

		for (const colliding of [
			{ ...original, payload: { nested: { a: 1, b: 3 } } },
			{ ...original, kind: "messages.interrupt" },
			{ ...original, resource: otherTimelineKey },
			{
				...original,
				environmentId: EnvironmentId.make("environment-2"),
				resource: null,
			},
		]) {
			await expect(bus.dispatch(colliding)).rejects.toBeInstanceOf(
				CommandIdentityCollisionError,
			);
		}
		expect(executions).toBe(0);
		await bus.dispose();
	});

	it("rejects a persisted outbox collision from another environment before execution", async () => {
		const persistence = new MemoryPersistence();
		const commandId = CommandId.make("command-cross-environment-collision");
		const original = {
			kind: "messages.send",
			commandId,
			environmentId,
			resource: timelineKey,
			payload: { text: "environment one" },
			retry: "safe" as const,
			createdAt: 1,
		};
		await persistence.putOutbox({
			command: original,
			fingerprint: commandFingerprint(original),
			attempts: 1,
			lastAttemptAt: 2,
		});
		let executions = 0;
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			commandExecutor: {
				execute: async (_client, command) => {
					executions += 1;
					return {
						commandId: command.commandId,
						receivedAt: 3,
						result: null,
					};
				},
			},
		});

		await expect(
			bus.dispatch({
				...original,
				environmentId: EnvironmentId.make("environment-2"),
				resource: null,
				payload: { text: "environment two" },
			}),
		).rejects.toBeInstanceOf(CommandIdentityCollisionError);
		expect(executions).toBe(0);
		expect(persistence.outbox.get(commandId)?.command).toEqual(original);
		await bus.dispose();
	});

	it("replays a persisted command with the same identity after restart", async () => {
		const persistence = new MemoryPersistence();
		const command = {
			kind: "messages.send",
			commandId: CommandId.make("command-restart"),
			environmentId,
			resource: timelineKey,
			payload: { text: "resume me" },
			retry: "safe" as const,
			createdAt: 1,
		};
		const fingerprint = commandFingerprint(command);
		await persistence.putOutbox({
			command,
			fingerprint,
			attempts: 1,
			lastAttemptAt: 2,
		});
		const seen: CommandId[] = [];
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			commandExecutor: {
				execute: async (_client, replayed) => {
					seen.push(replayed.commandId);
					return {
						commandId: replayed.commandId,
						receivedAt: 3,
						result: "accepted",
					};
				},
			},
		});

		bus.retain(timelineKey, { activation: "connect" });
		await waitUntil(() => seen.length === 1);
		expect(seen).toEqual([command.commandId]);
		await waitUntil(() => persistence.outbox.size === 0);
		expect(persistence.outbox.size).toBe(0);
		await bus.dispose();
	});

	it("returns a durable receipt after restart without executing again", async () => {
		const persistence = new MemoryPersistence();
		const command = {
			kind: "messages.send",
			commandId: CommandId.make("command-receipt-restart"),
			environmentId,
			resource: timelineKey,
			payload: { text: "already accepted" },
			retry: "safe" as const,
			createdAt: 1,
		};
		const fingerprint = commandFingerprint(command);
		await persistence.putReceipt({
			commandId: command.commandId,
			fingerprint,
			receivedAt: 2,
			result: "original",
		});
		let executions = 0;
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			commandExecutor: {
				execute: async (_client, replayed) => {
					executions += 1;
					return {
						commandId: replayed.commandId,
						receivedAt: 3,
						result: "duplicate",
					};
				},
			},
		});

		await expect(bus.dispatch(command)).resolves.toMatchObject({
			commandId: command.commandId,
			result: "original",
		});
		expect(executions).toBe(0);
		await bus.dispose();
	});

	it("serializes commands per qualified resource without blocking another resource", async () => {
		const firstGate = deferred<void>();
		const started: string[] = [];
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			commandExecutor: {
				execute: async (_client, command) => {
					started.push(command.commandId);
					if (command.commandId === "first") await firstGate.promise;
					return {
						commandId: command.commandId,
						receivedAt: Date.now(),
						result: command.commandId,
					};
				},
			},
		});
		const makeCommand = (commandId: string, resource: typeof timelineKey) => ({
			kind: "test.mutate",
			commandId: CommandId.make(commandId),
			environmentId,
			resource,
			payload: {},
			retry: "never" as const,
			createdAt: Date.now(),
		});

		const first = bus.dispatch(makeCommand("first", timelineKey));
		await waitUntil(() => started.includes("first"));
		const second = bus.dispatch(makeCommand("second", timelineKey));
		const independent = bus.dispatch(
			makeCommand("independent", otherTimelineKey),
		);
		await expect(independent).resolves.toMatchObject({
			commandId: "independent",
		});
		expect(started).toEqual(["first", "independent"]);

		firstGate.resolve();
		await expect(first).resolves.toMatchObject({ commandId: "first" });
		await expect(second).resolves.toMatchObject({ commandId: "second" });
		expect(started).toEqual(["first", "independent", "second"]);
		await bus.dispose();
	});

	it("routes transport command failures through the environment supervisor", async () => {
		const scheduled: Array<() => void> = [];
		let resolves = 0;
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(() => {
				resolves += 1;
			}),
			commandFaultFor: (cause) =>
				cause instanceof Error && cause.message === "socket closed"
					? { phase: "offline", message: cause.message }
					: null,
			commandExecutor: {
				execute: async () => {
					throw new Error("socket closed");
				},
			},
			runtime: {
				random: () => 0,
				schedule: (_delayMs, task) => {
					scheduled.push(task);
					return () => undefined;
				},
			},
		});
		const lease = bus.retain(timelineKey, { activation: "connect" });
		await waitUntil(() => bus.connection(environmentId).phase === "connected");
		await expect(
			bus.dispatch({
				kind: "test.mutate",
				commandId: CommandId.make("transport-failure"),
				environmentId,
				resource: timelineKey,
				payload: {},
				retry: "never",
				createdAt: Date.now(),
			}),
		).rejects.toThrow("socket closed");
		expect(bus.connection(environmentId).phase).toBe("offline");
		expect(scheduled).toHaveLength(1);

		scheduled[0]?.();
		await waitUntil(() => bus.connection(environmentId).phase === "connected");
		expect(resolves).toBe(2);
		lease.release();
		await bus.dispose();
	});

	it("keeps ambiguous transport failures but removes definitive domain failures from the outbox", async () => {
		const persistence = new MemoryPersistence();
		let failure: Error = new Error("socket closed");
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			commandFaultFor: (cause) =>
				cause instanceof Error && cause.message === "socket closed"
					? { phase: "offline", message: cause.message }
					: null,
			commandExecutor: {
				execute: async () => {
					throw failure;
				},
			},
		});
		const makeCommand = (id: string) => ({
			kind: "test.mutate",
			commandId: CommandId.make(id),
			environmentId,
			resource: timelineKey,
			payload: {},
			retry: "safe" as const,
			createdAt: Date.now(),
		});

		await expect(bus.dispatch(makeCommand("transport"))).rejects.toThrow(
			"socket closed",
		);
		expect(persistence.outbox.has(CommandId.make("transport"))).toBe(true);
		expect(bus.snapshot(timelineKey).failedCommands.at(-1)?.retryable).toBe(
			true,
		);

		failure = new Error("expected mtime did not match");
		await expect(bus.dispatch(makeCommand("domain"))).rejects.toThrow(
			"expected mtime did not match",
		);
		expect(persistence.outbox.has(CommandId.make("domain"))).toBe(false);
		expect(bus.snapshot(timelineKey).failedCommands.at(-1)?.retryable).toBe(
			false,
		);
		await bus.dispose();
	});
});
