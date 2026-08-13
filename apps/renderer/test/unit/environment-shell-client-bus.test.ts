import {
	ClientBus,
	type ResourceDriverContext,
} from "@zuse/client-runtime/client-bus";
import type { ResourcePersistence } from "@zuse/client-runtime/client-persistence";
import { EnvironmentId, FolderId } from "@zuse/contracts";
import { Effect, Queue, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
	type EnvironmentShellData,
	type EnvironmentShellDriverClient,
	environmentShellResourceKey,
	makeEnvironmentShellResourceDriver,
} from "../../src/lib/environment-shell-client-bus.ts";

const ref = { environmentId: EnvironmentId.make("environment-shell-test") };
const folder = (id: string) => ({
	id: FolderId.make(id),
	name: id,
	path: `/tmp/${id}`,
	addedAt: new Date(0),
});

describe("environment shell ClientBus driver", () => {
	it("qualifies the shell cache key by explicit environment", () => {
		expect(environmentShellResourceKey(ref).ref).toEqual(ref);
		expect(
			environmentShellResourceKey({
				environmentId: EnvironmentId.make("another-environment"),
			}),
		).not.toEqual(environmentShellResourceKey(ref));
	});

	it("hydrates a cache-only sidebar retain without resolving an environment", async () => {
		let resolves = 0;
		let starts = 0;
		const cached: EnvironmentShellData = {
			folders: [folder("cached")],
			originsByFolder: {},
			chatsByProject: {},
			sessionsByProject: {},
			creationOperationsByProject: {},
		};
		const persistence: ResourcePersistence = {
			loadResource: async <Data>() => ({
				data: cached as Data,
				cursor: { epoch: "cached-shell", version: 8 },
				storedAt: 1,
			}),
			saveResource: async () => undefined,
			removeResource: async () => undefined,
		};
		const bus = new ClientBus<EnvironmentShellDriverClient>({
			resolver: {
				resolve: () => {
					resolves += 1;
					return Effect.die("cache-only must not resolve");
				},
			},
			persistence,
			driverFor: () => ({
				start: () => {
					starts += 1;
				},
				stop: () => undefined,
			}),
		});

		const lease = bus.retain(environmentShellResourceKey(ref), {
			activation: "cache-only",
		});
		await vi.waitFor(() =>
			expect(bus.snapshot(environmentShellResourceKey(ref)).data).toEqual(
				cached,
			),
		);
		expect(bus.snapshot(environmentShellResourceKey(ref))).toMatchObject({
			origin: "cache",
			connection: "dormant",
			sync: "cached",
		});
		expect(resolves).toBe(0);
		expect(starts).toBe(0);
		lease.release();
		await bus.dispose();
	});

	it("shares one live shell driver until the final consumer releases it", async () => {
		const workspace = Effect.runSync(
			Queue.unbounded<ReadonlyArray<ReturnType<typeof folder>>>(),
		);
		let starts = 0;
		let stops = 0;
		const client = {
			"workspace.streamChanges": () => Stream.fromQueue(workspace),
			"chat.streamChanges": () => Stream.never,
			"session.streamChanges": () => Stream.never,
			"chat.creation.stream": () => Stream.never,
			"git.origin": () => Effect.succeed(null),
		} as unknown as EnvironmentShellDriverClient;
		const bus = new ClientBus<EnvironmentShellDriverClient>({
			resolver: {
				resolve: () =>
					Effect.succeed({ client, dispose: async () => undefined }),
			},
			driverFor: () => {
				const driver = makeEnvironmentShellResourceDriver({
					reportConnectionFailure: vi.fn(),
				});
				return {
					start: (context) => {
						starts += 1;
						return driver.start(
							context as ResourceDriverContext<
								EnvironmentShellDriverClient,
								EnvironmentShellData
							>,
						);
					},
					stop: () => {
						stops += 1;
						driver.stop();
					},
				};
			},
		});
		const key = environmentShellResourceKey(ref);
		const first = bus.retain(key, { activation: "connect" });
		const second = bus.retain(key, { activation: "connect" });
		await vi.waitFor(() => expect(starts).toBe(1));
		Queue.offerUnsafe(workspace, []);
		await vi.waitFor(() => expect(bus.snapshot(key).sync).toBe("live"));

		first.release();
		expect(stops).toBe(0);
		second.release();
		expect(stops).toBe(1);
		await bus.dispose();
	});

	it("keeps cached shell data when the live stream fails", async () => {
		const cached: EnvironmentShellData = {
			folders: [folder("cached")],
			originsByFolder: {},
			chatsByProject: {},
			sessionsByProject: {},
			creationOperationsByProject: {},
		};
		const client = {
			"workspace.streamChanges": () => Stream.fail(new Error("socket lost")),
			"chat.streamChanges": () => Stream.never,
			"session.streamChanges": () => Stream.never,
			"chat.creation.stream": () => Stream.never,
			"git.origin": () => Effect.succeed(null),
		} as unknown as EnvironmentShellDriverClient;
		let bus!: ClientBus<EnvironmentShellDriverClient>;
		bus = new ClientBus<EnvironmentShellDriverClient>({
			resolver: {
				resolve: () =>
					Effect.succeed({ client, dispose: async () => undefined }),
			},
			persistence: {
				loadResource: async <Data>() => ({
					data: cached as Data,
					cursor: { epoch: "cached-shell", version: 8 },
					storedAt: 1,
				}),
				saveResource: async () => undefined,
				removeResource: async () => undefined,
			},
			driverFor: () => {
				const driver = makeEnvironmentShellResourceDriver({
					reportConnectionFailure: (environmentId, generation, cause) => {
						bus.reportConnectionFault(
							environmentId,
							{ phase: "failed", message: String(cause) },
							generation,
						);
					},
				});
				return {
					start: (context) =>
						driver.start(
							context as ResourceDriverContext<
								EnvironmentShellDriverClient,
								EnvironmentShellData
							>,
						),
					stop: () => driver.stop(),
				};
			},
			runtime: { schedule: () => () => undefined },
		});
		const key = environmentShellResourceKey(ref);
		const lease = bus.retain(key, { activation: "cache-only" });
		await vi.waitFor(() => expect(bus.snapshot(key).origin).toBe("cache"));
		lease.activate("connect");
		await vi.waitFor(() => expect(bus.snapshot(key).connection).toBe("failed"));
		expect(bus.snapshot(key)).toMatchObject({
			data: cached,
			origin: "cache",
			connection: "failed",
		});
		lease.release();
		await bus.dispose();
	});

	it("switches the qualified project streams when the workspace changes", async () => {
		const workspace = Effect.runSync(
			Queue.unbounded<ReadonlyArray<ReturnType<typeof folder>>>(),
		);
		const subscribedProjects: string[] = [];
		const chatStream = ({ projectId }: { readonly projectId: FolderId }) => {
			subscribedProjects.push(`chat:${projectId}`);
			return Stream.make({ _tag: "snapshot" as const, chats: [] });
		};
		const client = {
			"workspace.streamChanges": () => Stream.fromQueue(workspace),
			"chat.streamChanges": chatStream,
			"session.streamChanges": ({
				projectId,
			}: {
				readonly projectId: FolderId;
			}) => {
				subscribedProjects.push(`session:${projectId}`);
				return Stream.make({
					_tag: "snapshot" as const,
					cursor: 0,
					sessions: [],
				});
			},
			"chat.creation.stream": ({
				projectId,
			}: {
				readonly projectId: FolderId;
			}) => {
				subscribedProjects.push(`creation:${projectId}`);
				return Stream.make({ _tag: "snapshot" as const, operations: [] });
			},
			"git.origin": () => Effect.succeed(null),
		} as unknown as EnvironmentShellDriverClient;
		const emitted: string[][] = [];
		const driver = makeEnvironmentShellResourceDriver({
			reportConnectionFailure: vi.fn(),
		});
		driver.start({
			key: environmentShellResourceKey(ref),
			client,
			generation: 4,
			data: null,
			cursor: null,
			snapshot: () => null,
			isCurrent: () => true,
			emit: (update) => {
				if (update.data !== undefined) {
					emitted.push(update.data.folders.map(({ id }) => id));
				}
				return true;
			},
		} satisfies ResourceDriverContext<
			EnvironmentShellDriverClient,
			EnvironmentShellData
		>);
		Queue.offerUnsafe(workspace, [folder("one")]);
		await vi.waitFor(() =>
			expect(subscribedProjects).toEqual(
				expect.arrayContaining(["chat:one", "session:one", "creation:one"]),
			),
		);
		Queue.offerUnsafe(workspace, [folder("two")]);
		await vi.waitFor(() =>
			expect(subscribedProjects).toEqual(
				expect.arrayContaining(["chat:two", "session:two", "creation:two"]),
			),
		);
		expect(emitted.some((ids) => ids.length === 1 && ids[0] === "one")).toBe(
			true,
		);
		expect(emitted.at(-1)).toEqual(["two"]);
		driver.stop();
	});

	it("drops a late materialization from an older generation", async () => {
		const workspace = Effect.runSync(
			Queue.unbounded<ReadonlyArray<ReturnType<typeof folder>>>(),
		);
		let current = true;
		const gate = Promise.withResolvers<void>();
		const emit = vi.fn(() => true);
		const driver = makeEnvironmentShellResourceDriver({
			reportConnectionFailure: vi.fn(),
		});
		driver.start({
			key: environmentShellResourceKey(ref),
			client: {
				"workspace.streamChanges": () => Stream.fromQueue(workspace),
				"chat.streamChanges": () => Stream.never,
				"session.streamChanges": () => Stream.never,
				"chat.creation.stream": () => Stream.never,
				"git.origin": () => Effect.promise(() => gate.promise.then(() => null)),
			} as unknown as EnvironmentShellDriverClient,
			generation: 3,
			data: null,
			cursor: null,
			snapshot: () => null,
			isCurrent: () => current,
			emit,
		} satisfies ResourceDriverContext<
			EnvironmentShellDriverClient,
			EnvironmentShellData
		>);
		Queue.offerUnsafe(workspace, [folder("one")]);
		current = false;
		gate.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(emit).not.toHaveBeenCalled();
		driver.stop();
	});
});
