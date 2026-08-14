import { EnvironmentId } from "@zuse/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
	type EnvironmentResolver,
	EnvironmentRuntimeRegistry,
} from "../../src/environment-runtime.ts";

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

describe("EnvironmentRuntimeRegistry", () => {
	it("retains sync activation without resolving a transport", async () => {
		let resolves = 0;
		const registry = new EnvironmentRuntimeRegistry<{ id: number }>({
			resolve: () => {
				resolves += 1;
				return Effect.succeed({
					client: { id: resolves },
					dispose: async () => undefined,
				});
			},
		});
		const runtime = registry.get(EnvironmentId.make("environment-sync"));
		const lease = runtime.retain("sync");
		expect(await lease.activate("sync")).toBeNull();
		expect(resolves).toBe(0);
		expect(runtime.snapshot().phase).toBe("dormant");
		lease.release();
		await registry.dispose();
	});

	it("owns one runtime and single-flights connection activation", async () => {
		const gate = deferred<{
			client: { id: number };
			dispose: () => Promise<void>;
		}>();
		let resolves = 0;
		const resolver: EnvironmentResolver<{ id: number }> = {
			resolve: () => {
				resolves += 1;
				return Effect.promise(() => gate.promise);
			},
		};
		const registry = new EnvironmentRuntimeRegistry(resolver);
		const environmentId = EnvironmentId.make("environment-1");
		const runtime = registry.get(environmentId);

		const first = runtime.retain("connect");
		const second = registry.get(environmentId).retain("connect");
		expect(registry.get(environmentId)).toBe(runtime);
		await waitUntil(() => resolves === 1);
		expect(resolves).toBe(1);

		gate.resolve({ client: { id: 1 }, dispose: async () => undefined });
		await waitUntil(() => runtime.snapshot().phase === "connected");
		expect(runtime.snapshot()).toMatchObject({
			generation: 1,
			phase: "connected",
		});
		first.release();
		second.release();
		await registry.dispose();
	});

	it("fences faults from an obsolete connection generation", async () => {
		let nextClient = 0;
		const disposed: number[] = [];
		const resolver: EnvironmentResolver<{ id: number }> = {
			resolve: () =>
				Effect.sync(() => {
					const id = ++nextClient;
					return {
						client: { id },
						dispose: async () => {
							disposed.push(id);
						},
					};
				}),
		};
		const registry = new EnvironmentRuntimeRegistry(resolver);
		const runtime = registry.get(EnvironmentId.make("environment-1"));
		const lease = runtime.retain("connect");
		await lease.activate("connect");

		expect(
			runtime.reportFault({ phase: "offline", message: "late close" }, 0),
		).toBe(false);
		expect(runtime.snapshot().phase).toBe("connected");

		expect(
			runtime.reportFault({ phase: "offline", message: "current close" }, 1),
		).toBe(true);
		expect(runtime.snapshot().phase).toBe("offline");
		await runtime.retryNow();
		expect(runtime.snapshot()).toMatchObject({
			phase: "connected",
			generation: 2,
		});
		lease.release();
		await registry.dispose();
		expect(disposed).toEqual([1, 2]);
	});

	it("activates transport callbacks with the committed runtime generation", async () => {
		const activated: number[] = [];
		const registry = new EnvironmentRuntimeRegistry<{ id: number }>({
			resolve: () =>
				Effect.succeed({
					client: { id: activated.length + 1 },
					dispose: async () => undefined,
					onActivated: (generation) => activated.push(generation),
				}),
		});
		const runtime = registry.get(EnvironmentId.make("environment-activation"));
		const lease = runtime.retain("connect");
		await lease.activate("connect");
		expect(activated).toEqual([1]);
		runtime.reportFault(
			{ phase: "failed", message: "socket closed" },
			runtime.snapshot().generation,
		);
		await runtime.retryNow();
		expect(activated).toEqual([1, 2]);
		lease.release();
		await registry.dispose();
	});

	it("does not reconnect when a live connection escalates from connect to wake", async () => {
		const activations: string[] = [];
		let disposals = 0;
		const registry = new EnvironmentRuntimeRegistry<{ id: number }>({
			resolve: (_environmentId, activation) => {
				activations.push(activation);
				return Effect.succeed({
					client: { id: activations.length },
					dispose: async () => {
						disposals += 1;
					},
				});
			},
		});
		const runtime = registry.get(EnvironmentId.make("environment-escalation"));
		const lease = runtime.retain("connect");
		const connected = await lease.activate("connect");
		const generation = runtime.snapshot().generation;

		expect(await lease.activate("wake")).toBe(connected);
		expect(activations).toEqual(["connect"]);
		expect(runtime.snapshot().generation).toBe(generation);
		expect(disposals).toBe(0);
		lease.release();
		await registry.dispose();
		expect(disposals).toBe(1);
	});

	it("executes a real wake when demand escalates during an in-flight connect", async () => {
		const connectGate = deferred<{
			client: { id: number };
			dispose: () => Promise<void>;
		}>();
		const activations: string[] = [];
		const disposed: number[] = [];
		const registry = new EnvironmentRuntimeRegistry<{ id: number }>({
			resolve: (_environmentId, activation) => {
				activations.push(activation);
				if (activation === "connect") {
					return Effect.promise(() => connectGate.promise);
				}
				return Effect.succeed({
					client: { id: 2 },
					dispose: async () => {
						disposed.push(2);
					},
				});
			},
		});
		const runtime = registry.get(EnvironmentId.make("environment-in-flight"));
		const connect = runtime.retain("connect");
		await waitUntil(() => activations.length === 1);
		const wake = runtime.retain("wake");
		connectGate.resolve({
			client: { id: 1 },
			dispose: async () => {
				disposed.push(1);
			},
		});
		await waitUntil(() => runtime.snapshot().phase === "connected");

		expect(activations).toEqual(["connect", "wake"]);
		expect(disposed).toEqual([1]);
		expect(runtime.currentClient()).toEqual({ id: 2 });
		expect(runtime.snapshot().generation).toBe(1);

		wake.release();
		connect.release();
		await registry.dispose();
	});

	it("is the single retry owner while retained and cancels retry on final release", async () => {
		let resolves = 0;
		let available = false;
		const scheduled: Array<{
			task: () => void;
			cancelled: boolean;
		}> = [];
		const resolver: EnvironmentResolver<{ id: number }> = {
			resolve: () => {
				resolves += 1;
				return available
					? Effect.succeed({
							client: { id: resolves },
							dispose: async () => undefined,
						})
					: Effect.fail({
							phase: "failed" as const,
							message: "network unavailable",
						});
			},
		};
		const registry = new EnvironmentRuntimeRegistry(resolver, {
			random: () => 0.5,
			schedule: (_delay, task) => {
				const item = { task, cancelled: false };
				scheduled.push(item);
				return () => {
					item.cancelled = true;
				};
			},
		});
		const runtime = registry.get(EnvironmentId.make("environment-retry"));
		const first = runtime.retain("connect");
		const second = runtime.retain("connect");
		await waitUntil(() => scheduled.length === 1);
		expect(resolves).toBe(1);

		available = true;
		scheduled[0]?.task();
		await waitUntil(() => runtime.snapshot().phase === "connected");
		expect(resolves).toBe(2);

		runtime.reportFault(
			{ phase: "failed", message: "socket closed" },
			runtime.snapshot().generation,
		);
		expect(scheduled).toHaveLength(2);
		first.release();
		expect(scheduled[1]?.cancelled).toBe(false);
		second.release();
		expect(scheduled[1]?.cancelled).toBe(true);
		await registry.dispose();
	});

	it("retries retained runtimes immediately after a platform online edge", async () => {
		let available = false;
		let resolves = 0;
		const scheduled: Array<{ task: () => void; cancelled: boolean }> = [];
		const registry = new EnvironmentRuntimeRegistry<{ id: number }>(
			{
				resolve: () => {
					resolves += 1;
					return available
						? Effect.succeed({
								client: { id: resolves },
								dispose: async () => undefined,
							})
						: Effect.fail({
								phase: "offline" as const,
								message: "offline",
							});
				},
			},
			{
				schedule: (_delay, task) => {
					const item = { task, cancelled: false };
					scheduled.push(item);
					return () => {
						item.cancelled = true;
					};
				},
			},
		);
		const runtime = registry.get(EnvironmentId.make("environment-online"));
		const lease = runtime.retain("connect");
		await waitUntil(() => scheduled.length === 1);

		available = true;
		registry.retryRetained();
		await waitUntil(() => runtime.snapshot().phase === "connected");

		expect(resolves).toBe(2);
		expect(scheduled[0]?.cancelled).toBe(true);
		lease.release();
		await registry.dispose();
	});

	it("does not resolve while offline and reconnects on the online edge", async () => {
		let online = false;
		let resolves = 0;
		const scheduled: Array<{ task: () => void; cancelled: boolean }> = [];
		const registry = new EnvironmentRuntimeRegistry<{ id: number }>(
			{
				resolve: () =>
					Effect.sync(() => ({
						client: { id: ++resolves },
						dispose: async () => undefined,
					})),
			},
			{
				isOnline: () => online,
				schedule: (_delay, task) => {
					const item = { task, cancelled: false };
					scheduled.push(item);
					return () => {
						item.cancelled = true;
					};
				},
			},
		);
		const runtime = registry.get(
			EnvironmentId.make("environment-platform-offline"),
		);
		const lease = runtime.retain("connect");
		await waitUntil(() => runtime.snapshot().phase === "offline");
		expect(resolves).toBe(0);
		expect(scheduled).toHaveLength(1);

		online = true;
		registry.retryRetained();
		await waitUntil(() => runtime.snapshot().phase === "connected");
		expect(resolves).toBe(1);
		expect(scheduled[0]?.cancelled).toBe(true);

		lease.release();
		await registry.dispose();
	});

	it("recomputes activation per lease and closes after final network downgrade", async () => {
		const activations: string[] = [];
		let disposals = 0;
		const registry = new EnvironmentRuntimeRegistry<{ id: number }>({
			resolve: (_environmentId, activation) => {
				activations.push(activation);
				return Effect.succeed({
					client: { id: activations.length },
					dispose: async () => {
						disposals += 1;
					},
				});
			},
		});
		const runtime = registry.get(EnvironmentId.make("environment-leases"));
		const sidebar = runtime.retain("cache-only");
		const chat = runtime.retain("wake");
		const terminal = runtime.retain("connect");
		await waitUntil(() => runtime.snapshot().phase === "connected");

		expect(activations).toEqual(["wake"]);
		chat.release();
		expect(runtime.snapshot().phase).toBe("connected");
		expect(disposals).toBe(0);

		await terminal.activate("cache-only");
		await waitUntil(() => disposals === 1);
		expect(runtime.snapshot().phase).toBe("dormant");
		expect(runtime.currentClient()).toBeNull();
		expect(activations).toEqual(["wake"]);

		terminal.release();
		sidebar.release();
		await registry.dispose();
	});
});
