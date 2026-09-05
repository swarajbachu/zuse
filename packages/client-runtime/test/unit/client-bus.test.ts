import { CommandId, EnvironmentId, SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
	ClientBus,
	type ResourceDriverContext,
	type ResourceSynchronization,
} from "../../src/client-bus.ts";
import type {
	ClientCommand,
	ClientPersistence,
	CloudCommandTransport,
	CommandDispatchHandle,
	CommandFingerprint,
	CommandReceipt,
	OutboxEntry,
	PersistedResource,
} from "../../src/client-persistence.ts";
import {
	CloudCommandTerminalError,
	CloudCommandTransportUnavailableError,
	CommandIdentityCollisionError,
	commandFingerprint,
	terminalErrorFromReceipt,
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

type TestCloudDispatchInput = {
	readonly command: ClientCommand;
	readonly fingerprint: CommandFingerprint;
};

type TestCloudResumeInput = TestCloudDispatchInput & {
	readonly encryptedEnvelope: unknown;
	readonly acceptance?: import("@zuse/contracts").CommandAcceptance;
	readonly deliveryStatus?: import("@zuse/contracts").CommandStatus;
};

const testCloudTransport = (
	dispatch: (input: TestCloudDispatchInput) => CommandDispatchHandle,
	resume:
		| ((input: TestCloudResumeInput) => CommandDispatchHandle)
		| null = null,
): CloudCommandTransport => {
	const prepare = (
		handle: CommandDispatchHandle,
		encryptedEnvelope: unknown,
	) => ({
		...handle,
		encryptedEnvelope:
			handle.encryptedEnvelope ?? Promise.resolve(encryptedEnvelope),
		deliveryFingerprint: Promise.resolve("hmac-sha256:test-envelope"),
		start: () => undefined,
		dispose: () => undefined,
	});
	return {
		supports: () => true,
		dispatch: ((input: TestCloudDispatchInput) =>
			prepare(dispatch(input), { test: "fresh" })) as never,
		resume: ((input: TestCloudResumeInput) =>
			prepare((resume ?? dispatch)(input), input.encryptedEnvelope)) as never,
	};
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
	it("fingerprints binary payloads by bytes instead of enumerable indices", () => {
		const binary = {
			kind: "attachments.upload",
			commandId: CommandId.make("command-binary"),
			environmentId,
			resource: timelineKey,
			payload: { bytes: new Uint8Array([1, 2, 3]) },
			retry: "never" as const,
			createdAt: 1,
		};

		expect(
			commandFingerprint({
				...binary,
				payload: { bytes: new Uint8Array([1, 2, 3]) },
			}),
		).toBe(commandFingerprint(binary));
		expect(
			commandFingerprint({
				...binary,
				payload: { bytes: new Uint8Array([1, 2, 4]) },
			}),
		).not.toBe(commandFingerprint(binary));
		// Uint8Array's enumerable shape is { "0": 1, ... }. It must retain a
		// distinct identity from a real application object with those keys.
		expect(
			commandFingerprint({
				...binary,
				payload: { bytes: { 0: 1, 1: 2, 2: 3 } },
			}),
		).not.toBe(commandFingerprint(binary));
	});

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

		activeContext.emit({
			data: { text: "caught up" },
			cursor: { epoch: "epoch-1", version: 2 },
			sync: "synchronizing",
			notify: false,
		});
		expect(bus.snapshot(timelineKey).data).toEqual({ text: "caught up" });
		expect(observed).toEqual(["live"]);
		activeContext.emit({ sync: "live" });
		expect(observed).toEqual(["live", "caught up"]);

		first.release();
		expect(cleanup).toBe(0);
		second.release();
		expect(cleanup).toBe(1);
		unsubscribe();
		await bus.dispose();
	});

	it("restarts a retained resource after its provisional subscription fails", async () => {
		let starts = 0;
		let stops = 0;
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			driverFor: () => ({
				start: () => {
					starts += 1;
				},
				stop: () => {
					stops += 1;
				},
			}),
		});
		const lease = bus.retain(timelineKey, { activation: "connect" });
		await waitUntil(() => starts === 1);

		expect(bus.restart(timelineKey)).toBe(true);
		expect(stops).toBe(1);
		expect(starts).toBe(2);

		lease.release();
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

	it("shares one checkpoint synchronization without waking the environment", async () => {
		const persistence = new MemoryPersistence();
		persistence.resources.set(resourceKeyId(timelineKey), {
			data: { text: "local" },
			cursor: { epoch: "epoch-1", version: 4 },
			storedAt: 1,
		});
		const checkpoint = deferred<{
			data: Timeline;
			cursor: { epoch: string; version: number };
		}>();
		let synchronizations = 0;
		let resolves = 0;
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(() => {
				resolves += 1;
			}),
			persistence,
			synchronizer: {
				synchronize: async <Data>() => {
					synchronizations += 1;
					return checkpoint.promise as Promise<ResourceSynchronization<Data>>;
				},
			},
		});

		const first = bus.retain(timelineKey, { activation: "sync" });
		const second = bus.retain(timelineKey, { activation: "sync" });
		await waitUntil(() => synchronizations === 1);
		expect(resolves).toBe(0);
		expect(bus.snapshot(timelineKey).data).toEqual({ text: "local" });

		checkpoint.resolve({
			data: { text: "cloud checkpoint" },
			cursor: { epoch: "epoch-1", version: 9 },
		});
		await waitUntil(() => bus.snapshot(timelineKey).origin === "checkpoint");
		expect(bus.snapshot(timelineKey)).toMatchObject({
			data: { text: "cloud checkpoint" },
			cursor: { epoch: "epoch-1", version: 9 },
			connection: "dormant",
			sync: "cached",
		});
		expect(persistence.resources.get(resourceKeyId(timelineKey))).toMatchObject(
			{
				data: { text: "cloud checkpoint" },
				cursor: { epoch: "epoch-1", version: 9 },
			},
		);
		first.release();
		second.release();
		await bus.dispose();
	});

	it("keeps a cached resource readable when wake fails", async () => {
		const persistence = new MemoryPersistence();
		persistence.resources.set(resourceKeyId(timelineKey), {
			data: { text: "offline transcript" },
			cursor: { epoch: "cache", version: 9 },
			storedAt: 1,
		});
		const bus = new ClientBus<Client>({
			resolver: {
				resolve: () =>
					Effect.fail({
						phase: "failed" as const,
						message: "sandbox is paused",
					}),
			},
			persistence,
			runtime: {
				schedule: () => () => undefined,
			},
		});

		const lease = bus.retain(timelineKey, { activation: "wake" });
		await waitUntil(() => bus.snapshot(timelineKey).data !== null);
		await waitUntil(
			() => bus.connection(environmentId).phase === "reconnecting",
		);
		expect(bus.snapshot(timelineKey)).toMatchObject({
			data: { text: "offline transcript" },
			origin: "cache",
			connection: "reconnecting",
		});

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

	it("hydrates persisted data before starting the runtime driver", async () => {
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
		await Promise.resolve();
		expect(context).toBeNull();

		cacheGate.resolve({
			data: { text: "old cache" },
			cursor: { epoch: "epoch", version: 3 },
			storedAt: 1,
		});
		await waitUntil(() => context !== null);
		expect(bus.snapshot(timelineKey)).toMatchObject({
			data: { text: "old cache" },
			origin: "cache",
			cursor: { epoch: "epoch", version: 3 },
		});
		const activeContext = context as unknown as ResourceDriverContext<
			Client,
			Timeline
		>;
		activeContext.emit({
			data: { text: "runtime" },
			cursor: { epoch: "epoch", version: 5 },
			sync: "live",
		});
		expect(bus.snapshot(timelineKey)).toMatchObject({
			data: { text: "runtime" },
			origin: "runtime",
			cursor: { epoch: "epoch", version: 5 },
		});
		await bus.dispose();
	});

	it("passes the command's environment to commandFaultFor", async () => {
		const faultFor = vi.fn(() => null);
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence: new MemoryPersistence(),
			commandExecutor: {
				execute: async () => {
					throw new Error("socket closed");
				},
			},
			commandFaultFor: faultFor,
		});
		await expect(
			bus.dispatch({
				kind: "messages.send",
				commandId: CommandId.make("command-fault-environment"),
				environmentId,
				resource: timelineKey,
				payload: { text: "hello" },
				retry: "safe" as const,
				createdAt: 1,
			}),
		).rejects.toThrow("socket closed");
		expect(faultFor).toHaveBeenCalledWith(expect.any(Error), environmentId);
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

	it("keeps an applied turn command pending until its resource reflects it", async () => {
		const persistence = new MemoryPersistence();
		const commandId = CommandId.make("command-awaiting-resource-reflection");
		let context: ResourceDriverContext<Client, Timeline> | null = null;
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			commandExecutor: {
				execute: async (_client, command) => ({
					commandId: command.commandId,
					receivedAt: 2,
					result: undefined,
				}),
			},
			commandReflected: (_command, view) =>
				(view.data as Timeline | null)?.text === "turn-reflected",
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
			data: { text: "before-turn" },
			cursor: { epoch: "epoch", version: 1 },
			sync: "live",
		});

		const result = bus.dispatch({
			kind: "messages.send",
			commandId,
			environmentId,
			resource: timelineKey,
			payload: { text: "hello" },
			retry: "safe",
			createdAt: 1,
			awaitResourceReflection: true,
		});

		await waitUntil(
			() =>
				bus.snapshot(timelineKey).pendingCommands[0]?.deliveryPhase ===
				"applied",
		);
		expect(bus.snapshot(timelineKey).pendingCommands).toEqual([
			expect.objectContaining({
				commandId,
				deliveryPhase: "applied",
			}),
		]);
		(context as unknown as ResourceDriverContext<Client, Timeline>).emit({
			data: { text: "turn-reflected" },
			cursor: { epoch: "epoch", version: 2 },
			sync: "live",
		});
		expect(bus.snapshot(timelineKey).pendingCommands).toEqual([]);
		await expect(result).resolves.toMatchObject({ commandId });
		await bus.dispose();
	});

	it("restores an applied turn fence from the outbox after a client restart", async () => {
		const persistence = new MemoryPersistence();
		const commandId = CommandId.make("command-reflection-restart");
		const command = {
			kind: "messages.send",
			commandId,
			environmentId,
			resource: timelineKey,
			payload: { text: "hello" },
			retry: "safe" as const,
			createdAt: 1,
			awaitResourceReflection: true,
		};
		let firstContext: ResourceDriverContext<Client, Timeline> | null = null;
		const first = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			commandExecutor: {
				execute: async (_client, replayed) => ({
					commandId: replayed.commandId,
					receivedAt: 2,
					result: undefined,
				}),
			},
			commandReflected: (_command, view) =>
				(view.data as Timeline | null)?.text === "turn-reflected",
			driverFor: () => ({
				start: (context) => {
					firstContext = context as ResourceDriverContext<Client, Timeline>;
				},
				stop: () => undefined,
			}),
		});
		first.retain(timelineKey, { activation: "connect" });
		await waitUntil(() => firstContext !== null);
		(firstContext as unknown as ResourceDriverContext<Client, Timeline>).emit({
			data: { text: "before-turn" },
			cursor: { epoch: "epoch", version: 1 },
			sync: "live",
		});
		const firstResult = first.dispatch(command);
		await waitUntil(
			() =>
				first.snapshot(timelineKey).pendingCommands[0]?.deliveryPhase ===
				"applied",
		);
		expect(
			persistence.outbox.get(commandId)?.command.resourceReflection,
		).toEqual({ cursor: { epoch: "epoch", version: 1 } });
		await first.dispose();
		await expect(firstResult).rejects.toThrow("ClientBus disposed");

		let replayed = 0;
		let secondContext: ResourceDriverContext<Client, Timeline> | null = null;
		const second = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			commandExecutor: {
				execute: async (_client, restored) => {
					replayed += 1;
					return {
						commandId: restored.commandId,
						receivedAt: 3,
						result: undefined,
					};
				},
			},
			commandReflected: (_command, view) =>
				(view.data as Timeline | null)?.text === "turn-reflected",
			driverFor: () => ({
				start: (context) => {
					secondContext = context as ResourceDriverContext<Client, Timeline>;
				},
				stop: () => undefined,
			}),
		});
		second.retain(timelineKey, { activation: "connect" });
		await waitUntil(() => secondContext !== null && replayed === 1);
		await waitUntil(
			() =>
				second.snapshot(timelineKey).pendingCommands[0]?.deliveryPhase ===
				"applied",
		);
		expect(persistence.outbox.has(commandId)).toBe(true);
		(secondContext as unknown as ResourceDriverContext<Client, Timeline>).emit({
			data: { text: "turn-reflected" },
			cursor: { epoch: "epoch", version: 2 },
			sync: "live",
		});
		await waitUntil(() => !persistence.outbox.has(commandId));
		expect(second.snapshot(timelineKey).pendingCommands).toEqual([]);
		await second.dispose();
	});

	it("accepts cloud commands without waking the live runtime", async () => {
		const persistence = new MemoryPersistence();
		let runtimeResolutions = 0;
		const resultGate = deferred<void>();
		const commandId = CommandId.make("durable-command-1");
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(() => {
				runtimeResolutions += 1;
			}),
			persistence,
			commandExecutor: {
				execute: async () => {
					throw new Error("live executor must not run");
				},
			},
			commandTransportFor: () =>
				testCloudTransport(({ command, fingerprint }) => ({
					accepted: Promise.resolve({
						commandId: command.commandId,
						workspaceSequence: 4,
						revision: 9,
						acceptedAt: 10,
						state: "accepted",
					}),
					result: resultGate.promise.then(() => ({
						commandId: command.commandId,
						fingerprint,
						receivedAt: 11,
						result: undefined as never,
					})),
					cancel: () => Promise.reject(new Error("not needed")),
				})),
		});
		const handle = bus.dispatchHandle({
			kind: "messages.send",
			commandId,
			environmentId,
			resource: timelineKey,
			payload: { commandId, sessionId: "session-1", text: "hello" },
			retry: "safe",
			createdAt: 1,
		});
		await expect(handle.accepted).resolves.toMatchObject({ revision: 9 });
		const secondCommandId = CommandId.make("durable-command-2");
		const second = bus.dispatchHandle({
			kind: "messages.send",
			commandId: secondCommandId,
			environmentId,
			resource: timelineKey,
			payload: {
				commandId: secondCommandId,
				sessionId: "session-1",
				text: "second",
			},
			retry: "safe",
			createdAt: 2,
		});
		await expect(second.accepted).resolves.toMatchObject({ revision: 9 });
		expect(runtimeResolutions).toBe(0);
		expect(persistence.outbox.get(commandId)?.acceptance?.revision).toBe(9);
		resultGate.resolve();
		await handle.result;
		await second.result;
		expect(persistence.outbox.has(commandId)).toBe(false);
		await bus.dispose();
	});

	it("preserves the resource lane when concurrent cloud commands fall back to live RPC", async () => {
		const persistence = new MemoryPersistence();
		const firstFallback = deferred<void>();
		const secondFallback = deferred<void>();
		const firstExecution = deferred<void>();
		const mailboxSelections: string[] = [];
		const liveExecutions: string[] = [];
		let concurrentExecutions = 0;
		let maximumConcurrentExecutions = 0;
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			commandExecutor: {
				execute: async (_client, command) => {
					liveExecutions.push(command.commandId);
					concurrentExecutions += 1;
					maximumConcurrentExecutions = Math.max(
						maximumConcurrentExecutions,
						concurrentExecutions,
					);
					if (command.commandId === "fallback-first") {
						await firstExecution.promise;
					}
					concurrentExecutions -= 1;
					return {
						commandId: command.commandId,
						receivedAt: Date.now(),
						result: command.commandId,
					};
				},
			},
			commandTransportFor: () =>
				testCloudTransport(({ command }) => {
					mailboxSelections.push(command.commandId);
					const unavailable = (
						command.commandId === "fallback-first"
							? firstFallback.promise
							: secondFallback.promise
					).then(() => {
						throw new CloudCommandTransportUnavailableError(
							"runtime does not support the mailbox",
						);
					});
					return {
						accepted: unavailable,
						result: unavailable,
						encryptedEnvelope: unavailable,
						cancel: () => Promise.reject(new Error("not accepted")),
					};
				}),
		});
		const makeCommand = (commandId: string) => ({
			kind: "messages.send",
			commandId: CommandId.make(commandId),
			environmentId,
			resource: timelineKey,
			payload: { commandId, sessionId: "session-1", text: commandId },
			retry: "safe" as const,
			createdAt: Date.now(),
		});

		const first = bus.dispatch(makeCommand("fallback-first"));
		const second = bus.dispatch(makeCommand("fallback-second"));
		await waitUntil(() => mailboxSelections.length === 2);
		expect(mailboxSelections).toEqual(["fallback-first", "fallback-second"]);

		// Even when the second capability check loses the race first, its live RPC
		// cannot overtake the command submitted ahead of it.
		secondFallback.resolve();
		await Promise.resolve();
		expect(liveExecutions).toEqual([]);
		firstFallback.resolve();
		await waitUntil(() => liveExecutions.length === 1);
		expect(liveExecutions).toEqual(["fallback-first"]);
		expect(maximumConcurrentExecutions).toBe(1);

		firstExecution.resolve();
		await expect(first).resolves.toMatchObject({ commandId: "fallback-first" });
		await expect(second).resolves.toMatchObject({
			commandId: "fallback-second",
		});
		expect(liveExecutions).toEqual(["fallback-first", "fallback-second"]);
		expect(maximumConcurrentExecutions).toBe(1);
		await bus.dispose();
	});

	it("keeps accepted delivery visible without resurrecting a completed outbox row", async () => {
		const statusWriteStarted = deferred<void>();
		const releaseStatusWrite = deferred<void>();
		class DelayedStatusPersistence extends MemoryPersistence {
			override async putOutbox(entry: OutboxEntry): Promise<void> {
				if (entry.deliveryStatus?.state === "leased") {
					statusWriteStarted.resolve();
					await releaseStatusWrite.promise;
				}
				await super.putOutbox(entry);
			}
		}
		const persistence = new DelayedStatusPersistence();
		const commandId = CommandId.make("durable-command-status");
		const resultGate = deferred<void>();
		let publishStatus:
			| ((status: import("@zuse/contracts").CommandStatus) => void)
			| undefined;
		let cancelCalls = 0;
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			commandExecutor: {
				execute: async () => {
					throw new Error("live executor must not run");
				},
			},
			commandTransportFor: () =>
				testCloudTransport(({ command, fingerprint }) => ({
					accepted: Promise.resolve({
						commandId: command.commandId,
						workspaceSequence: 4,
						revision: 9,
						acceptedAt: 10,
						state: "accepted",
					}),
					result: resultGate.promise.then(() => ({
						commandId: command.commandId,
						fingerprint,
						receivedAt: 12,
						result: undefined,
					})),
					cancel: async () => {
						cancelCalls += 1;
						throw new Error("not expected");
					},
					subscribeStatus: (listener) => {
						publishStatus = listener;
						return () => {
							if (publishStatus === listener) publishStatus = undefined;
						};
					},
				})),
		});
		const handle = bus.dispatchHandle({
			kind: "messages.send",
			commandId,
			environmentId,
			resource: timelineKey,
			payload: { commandId, sessionId: "session-1", text: "hello" },
			retry: "safe",
			createdAt: 1,
		});

		await expect(handle.accepted).resolves.toMatchObject({ revision: 9 });
		await waitUntil(() => publishStatus !== undefined);
		expect(bus.snapshot(timelineKey).pendingCommands).toEqual([
			expect.objectContaining({
				commandId,
				deliveryPhase: "waiting-for-runtime",
				cancellable: true,
			}),
		]);

		publishStatus?.({
			commandId,
			workspaceSequence: 4,
			revision: 10,
			state: "blocked",
			everLeased: false,
			updatedAt: 11,
			category: "sign-in-required",
			blockedUntil: "auth-restored",
		});
		expect(bus.snapshot(timelineKey).pendingCommands).toEqual([
			expect.objectContaining({
				commandId,
				deliveryPhase: "blocked",
				category: "sign-in-required",
				blockedUntil: "auth-restored",
				cancellable: true,
			}),
		]);

		publishStatus?.({
			commandId,
			workspaceSequence: 4,
			revision: 11,
			state: "leased",
			everLeased: true,
			updatedAt: 12,
		});
		const leased = bus.snapshot(timelineKey).pendingCommands;
		expect(leased).toEqual([
			expect.objectContaining({
				commandId,
				deliveryPhase: "leased",
				cancellable: false,
			}),
		]);
		expect(leased[0]?.category).toBeUndefined();
		expect(leased[0]?.blockedUntil).toBeUndefined();
		await expect(handle.cancel()).rejects.toThrow(
			"This command can no longer be cancelled",
		);
		expect(cancelCalls).toBe(0);

		await statusWriteStarted.promise;
		let resultSettled = false;
		const result = handle.result.finally(() => {
			resultSettled = true;
		});
		resultGate.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(resultSettled).toBe(false);
		expect(persistence.outbox.has(commandId)).toBe(true);

		releaseStatusWrite.resolve();
		await result;
		expect(persistence.outbox.has(commandId)).toBe(false);
		expect(persistence.receipts.has(commandId)).toBe(true);
		await bus.dispose();
	});

	it("persists the encrypted envelope before starting mailbox acceptance", async () => {
		const persistence = new MemoryPersistence();
		const commandId = CommandId.make("durable-envelope-first");
		let startedWithEnvelope = false;
		const acceptance = deferred<import("@zuse/contracts").CommandAcceptance>();
		const transport: CloudCommandTransport = {
			supports: () => true,
			dispatch: <Result>({
				command,
				fingerprint,
			}: {
				readonly command: ClientCommand<unknown, Result>;
				readonly fingerprint: CommandFingerprint;
			}) => ({
				accepted: acceptance.promise,
				result: acceptance.promise.then(() => ({
					commandId: command.commandId,
					fingerprint,
					receivedAt: 5,
					result: undefined as Result,
				})),
				encryptedEnvelope: Promise.resolve({ opaque: "ciphertext" }),
				deliveryFingerprint: Promise.resolve("hmac-sha256:envelope-first"),
				dispose: () => undefined,
				start: () => {
					startedWithEnvelope =
						persistence.outbox.get(command.commandId)?.encryptedEnvelope !==
						undefined;
					acceptance.resolve({
						commandId: command.commandId,
						workspaceSequence: 1,
						revision: 2,
						acceptedAt: 3,
						state: "accepted",
					});
				},
				cancel: () => Promise.reject(new Error("not needed")),
			}),
			resume: () => {
				throw new Error("fresh command must not resume");
			},
		};
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			commandExecutor: {
				execute: async () => {
					throw new Error("live executor must not run");
				},
			},
			commandTransportFor: () => transport,
		});

		const handle = bus.dispatchHandle({
			kind: "messages.send",
			commandId,
			environmentId,
			resource: timelineKey,
			payload: { commandId, sessionId: "session-1", text: "hello" },
			retry: "safe",
			createdAt: 1,
		});
		await expect(handle.accepted).resolves.toMatchObject({ revision: 2 });
		expect(startedWithEnvelope).toBe(true);
		await handle.result;
		await bus.dispose();
	});

	it("persists keyed delivery identity across termination immediately after acceptance", async () => {
		const persistence = new MemoryPersistence();
		const commandId = CommandId.make("durable-accepted-before-termination");
		const deliveryFingerprint = "hmac-sha256:accepted-before-termination";
		const acceptance = {
			commandId,
			workspaceSequence: 1,
			revision: 2,
			acceptedAt: 3,
			state: "accepted" as const,
		};
		const never = new Promise<never>(() => undefined);
		const firstTransport: CloudCommandTransport = {
			supports: () => true,
			dispatch: (() => ({
				accepted: Promise.resolve(acceptance),
				result: never,
				encryptedEnvelope: Promise.resolve({ opaque: "ciphertext" }),
				deliveryFingerprint: Promise.resolve(deliveryFingerprint),
				start: () => undefined,
				dispose: () => undefined,
				cancel: () => Promise.reject(new Error("not needed")),
			})) as never,
			resume: (() => {
				throw new Error("fresh command must not resume");
			}) as never,
		};
		const firstBus = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			commandExecutor: {
				execute: async () => {
					throw new Error("live executor must not run");
				},
			},
			commandTransportFor: () => firstTransport,
		});
		const firstHandle = firstBus.dispatchHandle({
			kind: "messages.send",
			commandId,
			environmentId,
			resource: timelineKey,
			payload: { commandId, sessionId: "session-1", text: "accepted" },
			retry: "safe",
			createdAt: 1,
		});
		void firstHandle.result.catch(() => undefined);
		await expect(firstHandle.accepted).resolves.toEqual(acceptance);
		await waitUntil(
			() => persistence.outbox.get(commandId)?.acceptance !== undefined,
		);
		expect(persistence.outbox.get(commandId)?.deliveryStatus).toMatchObject({
			commandId,
			fingerprint: deliveryFingerprint,
			state: "accepted",
		});
		await firstBus.dispose();

		let resumes = 0;
		const secondTransport: CloudCommandTransport = {
			supports: () => false,
			dispatch: (() => {
				throw new Error("accepted command must not enqueue again");
			}) as never,
			resume: (<Result>(input: TestCloudResumeInput) => {
				resumes += 1;
				if (input.deliveryStatus?.fingerprint !== deliveryFingerprint) {
					throw new Error("persisted delivery status lost keyed identity");
				}
				return {
					accepted: Promise.resolve(acceptance),
					result: Promise.resolve({
						commandId,
						fingerprint: input.fingerprint,
						receivedAt: 4,
						result: undefined as Result,
					}),
					encryptedEnvelope: Promise.resolve(input.encryptedEnvelope),
					deliveryFingerprint: Promise.resolve(deliveryFingerprint),
					start: () => undefined,
					dispose: () => undefined,
					cancel: () => Promise.reject(new Error("not needed")),
				};
			}) as never,
		};
		const secondBus = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			commandExecutor: {
				execute: async () => {
					throw new Error("live executor must not run");
				},
			},
			commandTransportFor: () => secondTransport,
		});
		await secondBus.flushDurableOutbox(environmentId);
		await waitUntil(() => resumes === 1 && !persistence.outbox.has(commandId));
		await secondBus.dispose();
	});

	it("removes an unreadable applied result from the retry outbox", async () => {
		const persistence = new MemoryPersistence();
		const commandId = CommandId.make("durable-result-invalid-command");
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			commandExecutor: {
				execute: async () => {
					throw new Error("live executor must not run");
				},
			},
			commandTransportFor: () =>
				testCloudTransport(({ command }) => ({
					accepted: Promise.resolve({
						commandId: command.commandId,
						workspaceSequence: 1,
						revision: 2,
						acceptedAt: 3,
						state: "accepted",
					}),
					result: Promise.reject(
						new CloudCommandTerminalError(
							"outcome-unknown",
							"result-invalid",
							"The command was applied, but its encrypted result could not be recovered.",
						),
					),
					cancel: () => Promise.reject(new Error("not needed")),
				})),
		});
		const handle = bus.dispatchHandle({
			kind: "messages.send",
			commandId,
			environmentId,
			resource: timelineKey,
			payload: { commandId, sessionId: "session-1", text: "hello" },
			retry: "safe",
			createdAt: 1,
		});
		await expect(handle.accepted).resolves.toBeDefined();
		await expect(handle.result).rejects.toMatchObject({
			name: "CloudCommandTerminalError",
			state: "outcome-unknown",
			category: "result-invalid",
		});
		expect(persistence.outbox.has(commandId)).toBe(false);
		expect(
			terminalErrorFromReceipt(persistence.receipts.get(commandId)),
		).toMatchObject({
			state: "outcome-unknown",
			category: "result-invalid",
		});
		expect(bus.snapshot(timelineKey).failedCommands.at(-1)?.retryable).toBe(
			false,
		);
		expect(bus.snapshot(timelineKey).failedCommands.at(-1)?.terminal).toEqual({
			state: "outcome-unknown",
			category: "result-invalid",
		});
		await bus.dispose();
	});

	it("keeps an accepted command pending through a transient result-watch retry", async () => {
		vi.useFakeTimers();
		try {
			const persistence = new MemoryPersistence();
			const commandId = CommandId.make("durable-accepted-watch-retry");
			const acceptance = {
				commandId,
				workspaceSequence: 1,
				revision: 2,
				acceptedAt: 3,
				state: "accepted" as const,
			};
			let dispatches = 0;
			let resumes = 0;
			const bus = new ClientBus<Client>({
				resolver: immediateResolver(),
				persistence,
				commandExecutor: {
					execute: async () => {
						throw new Error("live executor must not run");
					},
				},
				commandTransportFor: () =>
					testCloudTransport(
						() => {
							dispatches += 1;
							return {
								accepted: Promise.resolve(acceptance),
								result: Promise.reject(
									new Error("result watch temporarily disconnected"),
								),
								cancel: () => Promise.reject(new Error("not needed")),
							};
						},
						({ command, fingerprint }) => {
							resumes += 1;
							return {
								accepted: Promise.resolve(acceptance),
								result: Promise.resolve({
									commandId: command.commandId,
									fingerprint,
									receivedAt: 4,
									result: "applied",
								}),
								cancel: () => Promise.reject(new Error("not needed")),
							};
						},
					),
			});
			await vi.advanceTimersByTimeAsync(0);
			const command = {
				kind: "messages.send",
				commandId,
				environmentId,
				resource: timelineKey,
				payload: { commandId, sessionId: "session-1", text: "accepted" },
				retry: "safe" as const,
				createdAt: 1,
			};

			const handle = bus.dispatchHandle(command);
			const originalResult = bus.dispatch(command);
			expect(handle.result).toBe(originalResult);
			await expect(handle.accepted).resolves.toEqual(acceptance);
			await waitUntil(
				() => persistence.outbox.get(commandId)?.acceptance !== undefined,
			);
			await Promise.resolve();
			expect(bus.snapshot(timelineKey).pendingCommands).toEqual([
				expect.objectContaining({
					commandId,
					deliveryPhase: "waiting-for-runtime",
				}),
			]);
			expect(bus.snapshot(timelineKey).failedCommands).toEqual([]);
			expect(dispatches).toBe(1);
			expect(resumes).toBe(0);

			await vi.advanceTimersByTimeAsync(2_000);
			await expect(handle.result).resolves.toMatchObject({
				commandId,
				result: "applied",
			});
			expect(dispatches).toBe(1);
			expect(resumes).toBe(1);
			expect(bus.snapshot(timelineKey).pendingCommands).toEqual([]);
			expect(bus.snapshot(timelineKey).failedCommands).toEqual([]);
			expect(persistence.outbox.has(commandId)).toBe(false);
			await bus.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("reconstructs a persisted terminal outcome without dispatching the same ID", async () => {
		const persistence = new MemoryPersistence();
		const commandId = CommandId.make("durable-terminal-receipt-restart");
		const command = {
			kind: "messages.send",
			commandId,
			environmentId,
			resource: timelineKey,
			payload: { commandId, sessionId: "session-1", text: "terminal" },
			retry: "safe" as const,
			createdAt: 1,
		};
		let mailboxDispatches = 0;
		const first = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			commandExecutor: {
				execute: async () => {
					throw new Error("live executor must not run");
				},
			},
			commandTransportFor: () =>
				testCloudTransport(({ command: sent }) => {
					mailboxDispatches += 1;
					return {
						accepted: Promise.resolve({
							commandId: sent.commandId,
							workspaceSequence: 1,
							revision: 2,
							acceptedAt: 3,
							state: "accepted",
						}),
						result: Promise.reject(
							new CloudCommandTerminalError(
								"rejected",
								"interaction-expired",
								"The interaction expired.",
								4,
							),
						),
						cancel: () => Promise.reject(new Error("not needed")),
					};
				}),
		});
		await expect(first.dispatch(command)).rejects.toMatchObject({
			state: "rejected",
			category: "interaction-expired",
			occurredAt: 4,
		});
		expect(persistence.outbox.has(commandId)).toBe(false);
		expect(persistence.receipts.get(commandId)).toMatchObject({
			commandId,
			receivedAt: 4,
			terminalError: {
				state: "rejected",
				category: "interaction-expired",
				message: "The interaction expired.",
			},
		});
		await first.dispose();

		const restored = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			commandExecutor: {
				execute: async () => {
					throw new Error("live executor must not run");
				},
			},
			commandTransportFor: () =>
				testCloudTransport(() => {
					mailboxDispatches += 1;
					throw new Error("persisted terminal receipt must win");
				}),
		});
		await expect(restored.dispatch(command)).rejects.toMatchObject({
			name: "CloudCommandTerminalError",
			state: "rejected",
			category: "interaction-expired",
			message: "The interaction expired.",
			occurredAt: 4,
		});
		expect(mailboxDispatches).toBe(1);
		await restored.dispose();
	});

	it("replays a persisted durable command after the client restarts without waking compute", async () => {
		const persistence = new MemoryPersistence();
		const commandId = CommandId.make("durable-restored-command");
		const command = {
			kind: "messages.send",
			commandId,
			environmentId,
			resource: timelineKey,
			payload: { commandId, sessionId: "session-1", text: "restored" },
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
		let runtimeResolutions = 0;
		let mailboxDispatches = 0;
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(() => {
				runtimeResolutions += 1;
			}),
			persistence,
			commandExecutor: {
				execute: async () => {
					throw new Error("live executor must not run");
				},
			},
			commandTransportFor: () =>
				testCloudTransport(
					({ command: restored, fingerprint: restoredFingerprint }) => {
						mailboxDispatches += 1;
						return {
							accepted: Promise.resolve({
								commandId: restored.commandId,
								workspaceSequence: 1,
								revision: 2,
								acceptedAt: 3,
								state: "accepted",
							}),
							result: Promise.resolve({
								commandId: restored.commandId,
								fingerprint: restoredFingerprint,
								receivedAt: 4,
								result: undefined as never,
							}),
							cancel: () => Promise.reject(new Error("not needed")),
						};
					},
				),
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(mailboxDispatches).toBe(1);
		expect(runtimeResolutions).toBe(0);
		expect(persistence.outbox.has(commandId)).toBe(false);
		await bus.dispose();
	});

	it("keeps one dispatch handle through a transient mailbox retry", async () => {
		vi.useFakeTimers();
		try {
			const persistence = new MemoryPersistence();
			const commandId = CommandId.make("durable-transient-enqueue");
			let mailboxDispatches = 0;
			let providerApplications = 0;
			let runtimeResolutions = 0;
			const bus = new ClientBus<Client>({
				resolver: immediateResolver(() => {
					runtimeResolutions += 1;
				}),
				persistence,
				commandExecutor: {
					execute: async () => {
						throw new Error("live executor must not run");
					},
				},
				commandTransportFor: () =>
					testCloudTransport(({ command, fingerprint }) => {
						mailboxDispatches += 1;
						if (mailboxDispatches === 1) {
							const unavailable = Promise.reject(
								new Error("control plane temporarily unavailable"),
							);
							return {
								accepted: unavailable,
								result: unavailable,
								cancel: () => Promise.reject(new Error("not accepted")),
							};
						}
						return {
							accepted: Promise.resolve({
								commandId: command.commandId,
								workspaceSequence: 1,
								revision: 2,
								acceptedAt: 3,
								state: "accepted",
							}),
							result: Promise.resolve().then(() => {
								providerApplications += 1;
								return {
									commandId: command.commandId,
									fingerprint,
									receivedAt: 4,
									result: undefined as never,
								};
							}),
							cancel: () => Promise.reject(new Error("not needed")),
						};
					}),
			});
			// Drain the constructor's empty startup scan before creating fresh work.
			await vi.advanceTimersByTimeAsync(0);
			const command = {
				kind: "messages.send",
				commandId,
				environmentId,
				resource: timelineKey,
				payload: { commandId, sessionId: "session-1", text: "retry me" },
				retry: "safe" as const,
				createdAt: 1,
			};

			const handle = bus.dispatchHandle(command);
			let acceptanceSettlements = 0;
			let resultSettlements = 0;
			void handle.accepted.then(
				() => {
					acceptanceSettlements += 1;
				},
				() => {
					acceptanceSettlements += 1;
				},
			);
			void handle.result.then(
				() => {
					resultSettlements += 1;
				},
				() => {
					resultSettlements += 1;
				},
			);
			await waitUntil(() => mailboxDispatches === 1);
			expect(persistence.outbox.has(commandId)).toBe(true);
			expect(bus.snapshot(timelineKey).pendingCommands).toEqual([
				expect.objectContaining({ commandId }),
			]);
			expect(bus.snapshot(timelineKey).failedCommands).toEqual([]);
			expect(mailboxDispatches).toBe(1);
			expect(runtimeResolutions).toBe(0);
			expect(acceptanceSettlements).toBe(0);
			expect(resultSettlements).toBe(0);

			await vi.advanceTimersByTimeAsync(1_999);
			expect(mailboxDispatches).toBe(1);
			await vi.advanceTimersByTimeAsync(1);
			await waitUntil(() => mailboxDispatches === 2);
			await expect(handle.accepted).resolves.toMatchObject({ revision: 2 });
			await expect(handle.result).resolves.toMatchObject({ commandId });
			expect(acceptanceSettlements).toBe(1);
			expect(resultSettlements).toBe(1);
			expect(providerApplications).toBe(1);
			expect(persistence.outbox.has(commandId)).toBe(false);
			expect(runtimeResolutions).toBe(0);
			await bus.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the original resource lane while a mailbox command retries", async () => {
		vi.useFakeTimers();
		try {
			const persistence = new MemoryPersistence();
			const firstExecution = deferred<void>();
			const mailboxAttempts = new Map<string, number>();
			const mailboxSelections: string[] = [];
			const liveExecutions: string[] = [];
			const bus = new ClientBus<Client>({
				resolver: immediateResolver(),
				persistence,
				commandExecutor: {
					execute: async (_client, command) => {
						liveExecutions.push(command.commandId);
						if (command.commandId === "retry-lane-first") {
							await firstExecution.promise;
						}
						return {
							commandId: command.commandId,
							receivedAt: 3,
							result: undefined,
						};
					},
				},
				commandTransportFor: () =>
					testCloudTransport(({ command }) => {
						mailboxSelections.push(command.commandId);
						const attempts = (mailboxAttempts.get(command.commandId) ?? 0) + 1;
						mailboxAttempts.set(command.commandId, attempts);
						const cause =
							command.commandId === "retry-lane-first" && attempts === 1
								? new Error("control plane temporarily unavailable")
								: new CloudCommandTransportUnavailableError(
										"mailbox capability is unavailable",
									);
						const failure = Promise.reject(cause);
						return {
							accepted: failure,
							result: failure,
							encryptedEnvelope: failure,
							cancel: () => Promise.reject(new Error("not accepted")),
						};
					}),
			});
			await vi.advanceTimersByTimeAsync(0);
			const command = (commandId: string) => ({
				kind: "messages.send",
				commandId: CommandId.make(commandId),
				environmentId,
				resource: timelineKey,
				payload: { commandId, sessionId: "session-1", text: commandId },
				retry: "safe" as const,
				createdAt: 1,
			});

			const first = bus.dispatchHandle(command("retry-lane-first"));
			await waitUntil(() => mailboxSelections.length === 1);
			expect(bus.snapshot(timelineKey).pendingCommands).toEqual([
				expect.objectContaining({ commandId: "retry-lane-first" }),
			]);
			expect(bus.snapshot(timelineKey).failedCommands).toEqual([]);
			const second = bus.dispatchHandle(command("retry-lane-second"));
			await waitUntil(() => mailboxSelections.length === 2);
			expect(liveExecutions).toEqual([]);

			await vi.advanceTimersByTimeAsync(2_000);
			await waitUntil(() => liveExecutions.length === 1);
			expect(mailboxSelections).toEqual([
				"retry-lane-first",
				"retry-lane-second",
				"retry-lane-first",
			]);
			expect(liveExecutions).toEqual(["retry-lane-first"]);

			firstExecution.resolve();
			await expect(first.result).resolves.toMatchObject({
				commandId: "retry-lane-first",
			});
			await expect(second.result).resolves.toMatchObject({
				commandId: "retry-lane-second",
			});
			expect(liveExecutions).toEqual(["retry-lane-first", "retry-lane-second"]);
			await bus.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects the original dispatch handle when its mailbox retry is terminal", async () => {
		vi.useFakeTimers();
		try {
			const persistence = new MemoryPersistence();
			const commandId = CommandId.make("durable-terminal-retry");
			let mailboxDispatches = 0;
			let liveExecutions = 0;
			const bus = new ClientBus<Client>({
				resolver: immediateResolver(),
				persistence,
				commandExecutor: {
					execute: async () => {
						liveExecutions += 1;
						throw new Error("live executor must not run");
					},
				},
				commandTransportFor: () =>
					testCloudTransport(() => {
						mailboxDispatches += 1;
						const cause =
							mailboxDispatches === 1
								? new Error("control plane temporarily unavailable")
								: new CloudCommandTerminalError(
										"rejected",
										"workspace-deleted",
										"Workspace was deleted",
									);
						const failure = Promise.reject(cause);
						return {
							accepted: failure,
							result: failure,
							cancel: () => Promise.reject(new Error("not accepted")),
						};
					}),
			});
			await vi.advanceTimersByTimeAsync(0);
			const handle = bus.dispatchHandle({
				kind: "messages.send",
				commandId,
				environmentId,
				resource: timelineKey,
				payload: { commandId, sessionId: "session-1", text: "retry me" },
				retry: "safe",
				createdAt: 1,
			});
			const accepted = expect(handle.accepted).rejects.toMatchObject({
				state: "rejected",
				category: "workspace-deleted",
			});
			const result = expect(handle.result).rejects.toMatchObject({
				state: "rejected",
				category: "workspace-deleted",
			});
			await waitUntil(() => mailboxDispatches === 1);
			expect(bus.snapshot(timelineKey).pendingCommands).toEqual([
				expect.objectContaining({ commandId }),
			]);
			expect(bus.snapshot(timelineKey).failedCommands).toEqual([]);
			expect(mailboxDispatches).toBe(1);

			await vi.advanceTimersByTimeAsync(2_000);
			await Promise.all([accepted, result]);
			expect(mailboxDispatches).toBe(2);
			expect(liveExecutions).toBe(0);
			expect(persistence.outbox.has(commandId)).toBe(false);
			expect(bus.snapshot(timelineKey).failedCommands).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(4_000);
			expect(mailboxDispatches).toBe(2);
			await bus.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not retry the mailbox after durable-unavailable live fallback", async () => {
		vi.useFakeTimers();
		try {
			const persistence = new MemoryPersistence();
			const commandId = CommandId.make("durable-live-fallback-once");
			let mailboxDispatches = 0;
			let liveExecutions = 0;
			const bus = new ClientBus<Client>({
				resolver: immediateResolver(),
				persistence,
				commandExecutor: {
					execute: async (_client, command) => {
						liveExecutions += 1;
						return {
							commandId: command.commandId,
							receivedAt: 2,
							result: undefined,
						};
					},
				},
				commandTransportFor: () =>
					testCloudTransport(() => {
						mailboxDispatches += 1;
						const unavailable = Promise.reject(
							new CloudCommandTransportUnavailableError(
								"mailbox capability is unavailable",
							),
						);
						return {
							accepted: unavailable,
							result: unavailable,
							encryptedEnvelope: unavailable,
							cancel: () => Promise.reject(new Error("not accepted")),
						};
					}),
			});
			await vi.advanceTimersByTimeAsync(0);
			const handle = bus.dispatchHandle({
				kind: "messages.send",
				commandId,
				environmentId,
				resource: timelineKey,
				payload: { commandId, sessionId: "session-1", text: "fallback" },
				retry: "safe",
				createdAt: 1,
			});

			await expect(handle.accepted).resolves.toMatchObject({ commandId });
			await expect(handle.result).resolves.toMatchObject({ commandId });
			expect(mailboxDispatches).toBe(1);
			expect(liveExecutions).toBe(1);
			expect(persistence.outbox.has(commandId)).toBe(false);
			await vi.advanceTimersByTimeAsync(4_000);
			expect(mailboxDispatches).toBe(1);
			expect(liveExecutions).toBe(1);
			await bus.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not repeat a failed live fallback from the durable retry timer", async () => {
		vi.useFakeTimers();
		try {
			const persistence = new MemoryPersistence();
			const commandId = CommandId.make("durable-live-fallback-failure");
			let mailboxDispatches = 0;
			let liveExecutions = 0;
			const bus = new ClientBus<Client>({
				resolver: immediateResolver(),
				persistence,
				commandFaultFor: () => ({
					phase: "offline",
					message: "socket closed",
				}),
				commandExecutor: {
					execute: async () => {
						liveExecutions += 1;
						throw new Error("socket closed");
					},
				},
				commandTransportFor: () =>
					testCloudTransport(() => {
						mailboxDispatches += 1;
						const cause =
							mailboxDispatches === 1
								? new Error("control plane temporarily unavailable")
								: new CloudCommandTransportUnavailableError(
										"mailbox capability is unavailable",
									);
						const failure = Promise.reject(cause);
						return {
							accepted: failure,
							result: failure,
							encryptedEnvelope: failure,
							cancel: () => Promise.reject(new Error("not accepted")),
						};
					}),
			});
			await vi.advanceTimersByTimeAsync(0);
			const handle = bus.dispatchHandle({
				kind: "messages.send",
				commandId,
				environmentId,
				resource: timelineKey,
				payload: { commandId, sessionId: "session-1", text: "fallback" },
				retry: "safe",
				createdAt: 1,
			});
			const accepted = expect(handle.accepted).rejects.toThrow("socket closed");
			const result = expect(handle.result).rejects.toThrow("socket closed");
			await waitUntil(() => mailboxDispatches === 1);
			expect(bus.snapshot(timelineKey).pendingCommands).toEqual([
				expect.objectContaining({ commandId }),
			]);
			expect(bus.snapshot(timelineKey).failedCommands).toEqual([]);

			// A catalog/reconnect scan must not create another attempt while the
			// original dispatch promise owns its retry delay.
			await bus.flushDurableOutbox(environmentId);
			expect(mailboxDispatches).toBe(1);
			expect(liveExecutions).toBe(0);
			await vi.advanceTimersByTimeAsync(2_000);
			await Promise.all([accepted, result]);
			expect(mailboxDispatches).toBe(2);
			expect(liveExecutions).toBe(1);
			expect(persistence.outbox.has(commandId)).toBe(true);
			await vi.advanceTimersByTimeAsync(6_000);
			expect(mailboxDispatches).toBe(2);
			expect(liveExecutions).toBe(1);
			await bus.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("settles a retry-owned handle when the client bus is disposed", async () => {
		vi.useFakeTimers();
		try {
			const persistence = new MemoryPersistence();
			const commandId = CommandId.make("durable-retry-dispose");
			let mailboxDispatches = 0;
			const bus = new ClientBus<Client>({
				resolver: immediateResolver(),
				persistence,
				commandExecutor: {
					execute: async () => {
						throw new Error("live executor must not run");
					},
				},
				commandTransportFor: () =>
					testCloudTransport(() => {
						mailboxDispatches += 1;
						const failure = Promise.reject(
							new Error("control plane temporarily unavailable"),
						);
						return {
							accepted: failure,
							result: failure,
							cancel: () => Promise.reject(new Error("not accepted")),
						};
					}),
			});
			await vi.advanceTimersByTimeAsync(0);
			const handle = bus.dispatchHandle({
				kind: "messages.send",
				commandId,
				environmentId,
				resource: timelineKey,
				payload: { commandId, sessionId: "session-1", text: "retry me" },
				retry: "safe",
				createdAt: 1,
			});
			const accepted = expect(handle.accepted).rejects.toThrow(
				"ClientBus disposed",
			);
			const result = expect(handle.result).rejects.toThrow(
				"ClientBus disposed",
			);
			await waitUntil(() => mailboxDispatches === 1);
			expect(bus.snapshot(timelineKey).pendingCommands).toEqual([
				expect.objectContaining({ commandId }),
			]);
			expect(bus.snapshot(timelineKey).failedCommands).toEqual([]);

			await bus.dispose();
			await Promise.all([accepted, result]);
			expect(persistence.outbox.has(commandId)).toBe(true);
			await vi.advanceTimersByTimeAsync(4_000);
			expect(mailboxDispatches).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("resumes an accepted persisted command without enqueueing it again", async () => {
		const persistence = new MemoryPersistence();
		const commandId = CommandId.make("durable-accepted-command");
		const command = {
			kind: "messages.send",
			commandId,
			environmentId,
			resource: timelineKey,
			payload: { commandId, sessionId: "session-1", text: "accepted" },
			retry: "safe" as const,
			createdAt: 1,
		};
		const fingerprint = commandFingerprint(command);
		const acceptance = {
			commandId,
			workspaceSequence: 1,
			revision: 8,
			acceptedAt: 9,
			state: "accepted" as const,
		};
		await persistence.putOutbox({
			command,
			fingerprint,
			encryptedEnvelope: { opaque: "persisted-ciphertext" },
			acceptance,
			attempts: 1,
			lastAttemptAt: 2,
		});
		let dispatches = 0;
		let resumes = 0;
		const transport: CloudCommandTransport = {
			// Accepted rows remain drainable even after a rollout narrows support.
			supports: () => false,
			dispatch: () => {
				dispatches += 1;
				throw new Error("accepted command must not enqueue again");
			},
			resume: <Result>(input: {
				readonly command: ClientCommand<unknown, Result>;
				readonly fingerprint: CommandFingerprint;
				readonly encryptedEnvelope: unknown;
				readonly acceptance?: import("@zuse/contracts").CommandAcceptance;
				readonly deliveryStatus?: import("@zuse/contracts").CommandStatus;
			}) => {
				resumes += 1;
				if (input.acceptance === undefined)
					throw new Error("expected persisted acceptance");
				return {
					accepted: Promise.resolve(input.acceptance),
					result: Promise.resolve({
						commandId: input.command.commandId,
						fingerprint: input.fingerprint,
						receivedAt: 10,
						result: undefined as Result,
					}),
					encryptedEnvelope: Promise.resolve(input.encryptedEnvelope),
					deliveryFingerprint: Promise.resolve(
						"hmac-sha256:persisted-accepted",
					),
					start: () => undefined,
					dispose: () => undefined,
					cancel: () => Promise.reject(new Error("not needed")),
				};
			},
		};
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			commandExecutor: {
				execute: async () => {
					throw new Error("live executor must not run");
				},
			},
			commandTransportFor: () => transport,
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(persistence.outbox.size).toBe(0);
		expect(dispatches).toBe(0);
		expect(resumes).toBe(1);
		await bus.dispose();
	});

	it("retries an unaccepted command with the exact persisted envelope", async () => {
		const persistence = new MemoryPersistence();
		const commandId = CommandId.make("durable-prepared-command");
		const command = {
			kind: "messages.send",
			commandId,
			environmentId,
			resource: timelineKey,
			payload: { commandId, sessionId: "session-1", text: "prepared" },
			retry: "safe" as const,
			createdAt: 1,
		};
		const fingerprint = commandFingerprint(command);
		const persistedEnvelope = {
			iv: "original-iv",
			ciphertext: "original-ciphertext",
		};
		await persistence.putOutbox({
			command,
			fingerprint,
			encryptedEnvelope: persistedEnvelope,
			attempts: 1,
			lastAttemptAt: 2,
		});
		let dispatches = 0;
		let resumedEnvelope: unknown;
		let resumedAcceptance: unknown = "not-called";
		const transport: CloudCommandTransport = {
			// Prepared rows remain owned by v3 even if a later rollout narrows new
			// command eligibility; falling back would create a second execution path.
			supports: () => false,
			dispatch: () => {
				dispatches += 1;
				throw new Error("persisted envelope must not be regenerated");
			},
			resume: <Result>(input: TestCloudResumeInput) => {
				resumedEnvelope = input.encryptedEnvelope;
				resumedAcceptance = input.acceptance;
				return {
					accepted: Promise.resolve({
						commandId,
						workspaceSequence: 1,
						revision: 3,
						acceptedAt: 4,
						state: "accepted" as const,
					}),
					result: Promise.resolve({
						commandId,
						fingerprint,
						receivedAt: 5,
						result: undefined as Result,
					}),
					encryptedEnvelope: Promise.resolve(input.encryptedEnvelope),
					deliveryFingerprint: Promise.resolve(
						"hmac-sha256:persisted-prepared",
					),
					start: () => undefined,
					dispose: () => undefined,
					cancel: () => Promise.reject(new Error("not needed")),
				};
			},
		};
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			commandExecutor: {
				execute: async () => {
					throw new Error("live executor must not run");
				},
			},
			commandTransportFor: () => transport,
		});

		await bus.flushDurableOutbox(environmentId);
		await waitUntil(() => persistence.outbox.size === 0);
		expect(dispatches).toBe(0);
		expect(resumedEnvelope).toBe(persistedEnvelope);
		expect(resumedAcceptance).toBeUndefined();
		await bus.dispose();
	});

	it("keeps mailbox ownership when unavailability follows envelope persistence", async () => {
		vi.useFakeTimers();
		try {
			const persistence = new MemoryPersistence();
			const commandId = CommandId.make("durable-envelope-before-unavailable");
			const persistedEnvelope = { opaque: "possible-server-identity" };
			let mailboxDispatches = 0;
			let liveExecutions = 0;
			const bus = new ClientBus<Client>({
				resolver: immediateResolver(),
				persistence,
				commandExecutor: {
					execute: async () => {
						liveExecutions += 1;
						return { commandId, receivedAt: 3, result: undefined };
					},
				},
				commandTransportFor: () =>
					testCloudTransport(() => {
						mailboxDispatches += 1;
						const unavailable = Promise.reject(
							new CloudCommandTransportUnavailableError(
								"enqueue eligibility changed after preparation",
							),
						);
						return {
							accepted: unavailable,
							result: unavailable,
							encryptedEnvelope: Promise.resolve(persistedEnvelope),
							cancel: () => Promise.reject(new Error("not accepted")),
						};
					}),
			});
			await vi.advanceTimersByTimeAsync(0);
			const command = {
				kind: "messages.send",
				commandId,
				environmentId,
				resource: timelineKey,
				payload: { commandId, sessionId: "session-1", text: "prepared" },
				retry: "safe" as const,
				createdAt: 1,
			};

			const result = bus.dispatch(command);
			let settled = false;
			void result.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			await waitUntil(
				() =>
					persistence.outbox.get(commandId)?.encryptedEnvelope !== undefined,
			);
			await Promise.resolve();
			expect(settled).toBe(false);
			expect(mailboxDispatches).toBe(1);
			expect(liveExecutions).toBe(0);
			expect(persistence.outbox.get(commandId)?.encryptedEnvelope).toBe(
				persistedEnvelope,
			);

			// Discovery cannot create a second attempt while the original promise owns it.
			await bus.flushDurableOutbox(environmentId);
			expect(mailboxDispatches).toBe(1);
			await bus.dispose();
			await expect(result).rejects.toThrow("ClientBus disposed");
			await vi.advanceTimersByTimeAsync(4_000);
			expect(mailboxDispatches).toBe(1);
			expect(liveExecutions).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not start a prepared mailbox request after disposal", async () => {
		const persistence = new MemoryPersistence();
		const commandId = CommandId.make("durable-dispose-before-start");
		const envelope = deferred<unknown>();
		const never = new Promise<never>(() => undefined);
		let starts = 0;
		let disposals = 0;
		const transport: CloudCommandTransport = {
			supports: () => true,
			dispatch: (() => ({
				accepted: never,
				result: never,
				encryptedEnvelope: envelope.promise,
				deliveryFingerprint: Promise.resolve(
					"hmac-sha256:disposed-before-start",
				),
				start: () => {
					starts += 1;
				},
				dispose: () => {
					disposals += 1;
				},
				cancel: () => Promise.reject(new Error("not accepted")),
			})) as never,
			resume: (() => {
				throw new Error("fresh command must not resume");
			}) as never,
		};
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			commandExecutor: {
				execute: async () => {
					throw new Error("live executor must not run");
				},
			},
			commandTransportFor: () => transport,
		});
		const result = bus.dispatch({
			kind: "messages.send",
			commandId,
			environmentId,
			resource: timelineKey,
			payload: { commandId, sessionId: "session-1", text: "prepared" },
			retry: "safe",
			createdAt: 1,
		});
		const rejected = expect(result).rejects.toThrow("ClientBus disposed");
		await waitUntil(() => persistence.outbox.has(commandId));

		await bus.dispose();
		envelope.resolve({ opaque: "persisted-before-network" });
		await rejected;
		await waitUntil(
			() => persistence.outbox.get(commandId)?.encryptedEnvelope !== undefined,
		);
		expect(starts).toBe(0);
		expect(disposals).toBe(1);
		expect(persistence.outbox.get(commandId)?.encryptedEnvelope).toEqual({
			opaque: "persisted-before-network",
		});
	});

	it("falls back once when transport preparation is synchronously unavailable", async () => {
		const persistence = new MemoryPersistence();
		const commandId = CommandId.make("durable-sync-unavailable");
		let mailboxDispatches = 0;
		let liveExecutions = 0;
		const unavailable = () => {
			mailboxDispatches += 1;
			throw new CloudCommandTransportUnavailableError(
				"mailbox capability is unavailable",
			);
		};
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			commandExecutor: {
				execute: async (_client, command) => {
					liveExecutions += 1;
					return {
						commandId: command.commandId,
						receivedAt: 2,
						result: undefined,
					};
				},
			},
			commandTransportFor: () => ({
				supports: () => true,
				dispatch: unavailable as never,
				resume: unavailable as never,
			}),
		});

		const handle = bus.dispatchHandle({
			kind: "messages.send",
			commandId,
			environmentId,
			resource: timelineKey,
			payload: { commandId, sessionId: "session-1", text: "fallback" },
			retry: "safe",
			createdAt: 1,
		});

		await expect(handle.accepted).resolves.toMatchObject({ commandId });
		await expect(handle.result).resolves.toMatchObject({ commandId });
		expect(mailboxDispatches).toBe(1);
		expect(liveExecutions).toBe(1);
		expect(persistence.outbox.has(commandId)).toBe(false);
		await bus.dispose();
	});

	it("never falls back to live RPC after a mailbox envelope exists", async () => {
		const persistence = new MemoryPersistence();
		const commandId = CommandId.make("durable-prepared-without-transport");
		const command = {
			kind: "messages.send",
			commandId,
			environmentId,
			resource: timelineKey,
			payload: { commandId, sessionId: "session-1", text: "prepared" },
			retry: "safe" as const,
			createdAt: 1,
		};
		const fingerprint = commandFingerprint(command);
		await persistence.putOutbox({
			command,
			fingerprint,
			encryptedEnvelope: { opaque: "possible-server-identity" },
			attempts: 1,
			lastAttemptAt: 2,
		});
		let liveExecutions = 0;
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			commandExecutor: {
				execute: async () => {
					liveExecutions += 1;
					return { commandId, receivedAt: 3, result: undefined };
				},
			},
		});

		const result = bus.dispatch(command);
		let settled = false;
		void result.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(liveExecutions).toBe(0);
		expect(persistence.outbox.get(commandId)?.encryptedEnvelope).toEqual({
			opaque: "possible-server-identity",
		});
		await bus.dispose();
		await expect(result).rejects.toThrow("ClientBus disposed");
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

	it("preserves tagged command failures whose Error message is empty", async () => {
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			commandExecutor: {
				execute: async () => {
					const failure = new Error("") as Error & {
						readonly _tag: string;
						readonly sessionId: string;
					};
					Object.assign(failure, {
						_tag: "SessionNotFoundError",
						sessionId: "session-1",
					});
					throw failure;
				},
			},
		});
		await expect(
			bus.dispatch({
				kind: "test.mutate",
				commandId: CommandId.make("tagged-failure"),
				environmentId,
				resource: timelineKey,
				payload: {},
				retry: "never",
				createdAt: Date.now(),
			}),
		).rejects.toMatchObject({ _tag: "SessionNotFoundError" });
		expect(bus.snapshot(timelineKey).failedCommands.at(-1)?.error).toBe(
			"SessionNotFoundError",
		);
		await bus.dispose();
	});

	it("forgets only inactive resource cells before a fresh replay", async () => {
		const persistence = new MemoryPersistence();
		const bus = new ClientBus<Client>({
			resolver: immediateResolver(),
			persistence,
			driverFor: () => ({
				start: (context) => {
					context.emit({
						data: { text: "live" },
						cursor: { epoch: "one", version: 1 },
						sync: "live",
					});
				},
				stop: () => undefined,
			}),
		});
		const lease = bus.retain(timelineKey, { activation: "connect" });
		await waitUntil(() => bus.snapshot(timelineKey).data?.text === "live");
		expect(bus.forget(timelineKey)).toBe(false);
		lease.release();
		expect(bus.forget(timelineKey)).toBe(true);
		expect(bus.snapshot(timelineKey).data).toBeNull();
		await bus.dispose();
	});
});
