import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import {
	type ClientConnectionError,
	createConnectionSupervisor,
} from "../../src/supervisor.js";

type Options = {
	readonly key: string;
	readonly token?: string;
	readonly routeGeneration?: number;
};
type Client = { readonly id: number };

const deferred = <A>() => {
	let resolve!: (value: A) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<A>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
};

const makeHarness = (input?: {
	online?: boolean;
	maxAutomaticAttempts?: number | ((options: Options) => number);
	prepareOptions?: (options: Options) => Promise<Options>;
	createClient?: (
		options: Options,
		signal: AbortSignal,
	) => Promise<{
		readonly client: Client;
		readonly dispose: () => Promise<void>;
	}>;
	validateClient?: (client: Client) => Promise<void>;
	isRetryableCommandError?: (cause: unknown) => boolean;
	isIgnorableFailure?: (cause: unknown) => boolean;
	shouldReconnectOnOptionsChange?: (
		previous: Options,
		next: Options,
	) => boolean;
	requiresNetwork?: (options: Options) => boolean;
	now?: () => number;
	confirmFailuresWithProbe?: boolean;
}) => {
	let online = input?.online ?? true;
	let nextId = 0;
	const scheduled: { delayMs: number; fn: () => void; cancelled: boolean }[] =
		[];
	const disposed: number[] = [];
	const created: Options[] = [];
	const supervisor = createConnectionSupervisor<Options, Client>({
		keyOf: (options) => options.key,
		isOnline: () => online,
		requiresNetwork: input?.requiresNetwork,
		now: input?.now,
		confirmFailuresWithProbe: input?.confirmFailuresWithProbe,
		maxAutomaticAttempts: input?.maxAutomaticAttempts,
		prepareOptions: input?.prepareOptions,
		validateClient: input?.validateClient,
		isRetryableCommandError: input?.isRetryableCommandError,
		isIgnorableFailure: input?.isIgnorableFailure,
		shouldReconnectOnOptionsChange: input?.shouldReconnectOnOptionsChange,
		createClient:
			input?.createClient ??
			(async (options) => {
				created.push(options);
				const client = { id: ++nextId };
				return {
					client,
					dispose: async () => {
						disposed.push(client.id);
					},
				};
			}),
		schedule: (delayMs, fn) => {
			const item = { delayMs, fn, cancelled: false };
			scheduled.push(item);
			return () => {
				item.cancelled = true;
			};
		},
	});
	return {
		supervisor,
		scheduled,
		disposed,
		created,
		setOnline: (value: boolean) => {
			online = value;
			supervisor.setOnline(value);
		},
	};
};

const runClient = <Client>(
	effect: Effect.Effect<Client, ClientConnectionError>,
) => Effect.runPromise(effect);

const waitUntil = async (predicate: () => boolean): Promise<void> => {
	for (let index = 0; index < 50; index += 1) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error("condition was not reached");
};

describe("connection supervisor", () => {
	test("deduplicates concurrent initialization", async () => {
		const gate = deferred<{
			readonly client: Client;
			readonly dispose: () => Promise<void>;
		}>();
		let calls = 0;
		const harness = makeHarness({
			createClient: () => {
				calls += 1;
				return gate.promise;
			},
		});
		const entry = harness.supervisor.get({ key: "local" });
		const first = runClient(entry.getClient());
		const second = runClient(entry.getClient());
		gate.resolve({ client: { id: 1 }, dispose: async () => undefined });

		await expect(Promise.all([first, second])).resolves.toEqual([
			{ id: 1 },
			{ id: 1 },
		]);
		expect(calls).toBe(1);
	});

	test("keeps a network-free connection alive across platform offline edges", async () => {
		const harness = makeHarness({
			requiresNetwork: (options) => options.key !== "local",
		});
		const entry = harness.supervisor.get({ key: "local" });
		const client = await runClient(entry.getClient());
		expect(entry.snapshot()).toMatchObject({
			status: "connected",
			generation: 1,
		});

		harness.setOnline(false);

		expect(entry.snapshot()).toMatchObject({
			status: "connected",
			generation: 1,
		});
		expect(harness.disposed).toEqual([]);
		expect(harness.scheduled).toEqual([]);
		await expect(runClient(entry.getClient())).resolves.toBe(client);

		harness.setOnline(true);
		expect(entry.snapshot()).toMatchObject({
			status: "connected",
			generation: 1,
		});
		expect(harness.created).toHaveLength(1);
	});

	test("connects a network-free connection while the platform is offline", async () => {
		const harness = makeHarness({
			online: false,
			requiresNetwork: () => false,
		});
		const entry = harness.supervisor.get({ key: "local" });
		expect(entry.snapshot().status).toBe("connecting");
		await expect(runClient(entry.getClient())).resolves.toEqual({ id: 1 });
		expect(entry.snapshot().status).toBe("connected");
	});

	test("gates only network connections on the platform online state", async () => {
		const harness = makeHarness({
			requiresNetwork: (options) => options.key === "remote",
		});
		const local = harness.supervisor.get({ key: "local" });
		const remote = harness.supervisor.get({ key: "remote" });
		const localClient = await runClient(local.getClient());
		const remoteClient = await runClient(remote.getClient());

		harness.setOnline(false);

		expect(remote.snapshot().status).toBe("offline");
		await waitUntil(() => harness.disposed.length === 1);
		expect(harness.disposed).toEqual([remoteClient.id]);
		await expect(runClient(remote.getClient())).rejects.toThrow("offline");
		expect(local.snapshot().status).toBe("connected");
		await expect(runClient(local.getClient())).resolves.toBe(localClient);
	});

	test("starts offline and connects on online wakeup without consuming retries", async () => {
		const harness = makeHarness({ online: false });
		const entry = harness.supervisor.get({ key: "local" });

		await expect(runClient(entry.getClient())).rejects.toThrow("offline");
		expect(entry.snapshot()).toMatchObject({ status: "offline", attempt: 0 });
		expect(harness.scheduled).toHaveLength(0);

		harness.setOnline(true);
		await runClient(entry.getClient());
		expect(entry.snapshot()).toMatchObject({
			status: "connected",
			generation: 1,
		});
	});

	test("resets failed initialization and caps transient retry backoff", async () => {
		let failures = 5;
		const harness = makeHarness({
			createClient: async () => {
				if (failures > 0) {
					failures -= 1;
					throw new Error("network down");
				}
				return { client: { id: 1 }, dispose: async () => undefined };
			},
		});
		const entry = harness.supervisor.get({ key: "remote" });

		await expect(runClient(entry.getClient())).rejects.toThrow("network down");
		for (let index = 0; index < 5; index += 1) {
			harness.scheduled[index]?.fn();
			if (index < 4) {
				await waitUntil(() => harness.scheduled.length === index + 2);
			}
		}

		expect(harness.scheduled.map(({ delayMs }) => delayMs)).toEqual([
			1_000, 2_000, 4_000, 8_000, 16_000,
		]);
		await runClient(entry.getClient());
		expect(entry.snapshot().status).toBe("connected");
	});

	test("blocks authentication failures until explicit retry", async () => {
		let blocked = true;
		const harness = makeHarness({
			createClient: async () => {
				if (blocked) throw new Error("api_connect_401");
				return { client: { id: 1 }, dispose: async () => undefined };
			},
		});
		const entry = harness.supervisor.get({ key: "remote" });

		await expect(runClient(entry.getClient())).rejects.toThrow(
			"api_connect_401",
		);
		expect(entry.snapshot().status).toBe("blockedAuth");
		expect(harness.scheduled).toHaveLength(0);

		blocked = false;
		entry.retryNow();
		await runClient(entry.getClient());
		expect(entry.snapshot().status).toBe("connected");
	});

	test("applies a per-connection retry limit", async () => {
		const harness = makeHarness({
			maxAutomaticAttempts: (options) =>
				options.key.startsWith("workspace:") ? 1 : Number.POSITIVE_INFINITY,
			createClient: async () => {
				throw new Error("socket did not open");
			},
		});
		const cloud = harness.supervisor.get({ key: "workspace:one" });
		const computer = harness.supervisor.get({ key: "environment:mac" });

		await expect(runClient(cloud.getClient())).rejects.toThrow();
		await expect(runClient(computer.getClient())).rejects.toThrow();
		for (let index = 0; index < 8; index += 1) {
			const before = harness.scheduled.length;
			harness.scheduled.at(-1)?.fn();
			await waitUntil(() => harness.scheduled.length === before + 1);
		}

		expect(cloud.snapshot().status).toBe("error");
		expect(computer.snapshot()).toMatchObject({
			status: "reconnecting",
			attempt: 9,
		});
	});

	test("stops automatic retries at the configured limit and resets on manual retry", async () => {
		let available = false;
		const harness = makeHarness({
			maxAutomaticAttempts: 2,
			createClient: async () => {
				if (!available) throw new Error("socket did not open");
				return { client: { id: 1 }, dispose: async () => undefined };
			},
		});
		const entry = harness.supervisor.get({ key: "remote" });

		await expect(runClient(entry.getClient())).rejects.toThrow(
			"socket did not open",
		);
		harness.scheduled[0]?.fn();
		await waitUntil(() => entry.snapshot().status === "error");

		expect(entry.snapshot()).toMatchObject({
			status: "error",
			attempt: 2,
		});
		expect(harness.scheduled).toHaveLength(1);
		await expect(runClient(entry.getClient())).rejects.toThrow(
			"socket did not open",
		);
		expect(harness.scheduled).toHaveLength(1);

		available = true;
		entry.retryNow();
		await waitUntil(() => entry.snapshot().status === "connected");
		expect(entry.snapshot()).toMatchObject({
			status: "connected",
			attempt: 0,
		});
	});

	test("refreshes prepared options before reconnecting", async () => {
		let token = 0;
		const harness = makeHarness({
			prepareOptions: async (options) => ({
				...options,
				token: `token-${++token}`,
			}),
		});
		const entry = harness.supervisor.get({ key: "remote", token: "stale" });

		await runClient(entry.getClient());
		entry.reportFailure(new Error("socket closed"));
		harness.scheduled.at(-1)?.fn();
		await runClient(entry.getClient());

		expect(harness.created.map(({ token }) => token)).toEqual([
			"token-1",
			"token-2",
		]);
	});

	test("does not treat prepared credentials as a configured option change", async () => {
		const configured = { key: "remote", token: "account-grant" };
		const harness = makeHarness({
			prepareOptions: async (options) => ({
				...options,
				token: "ephemeral-connect-token",
			}),
			shouldReconnectOnOptionsChange: (previous, next) =>
				previous.token !== next.token,
		});
		const entry = harness.supervisor.get(configured);
		await runClient(entry.getClient());

		const sameEntry = harness.supervisor.get(configured);
		await runClient(sameEntry.getClient());

		expect(sameEntry.snapshot().generation).toBe(1);
		expect(harness.created).toHaveLength(1);
		expect(harness.disposed).toEqual([]);
	});

	test("does not replace a healthy client for an ignorable cancellation", async () => {
		const harness = makeHarness({
			isIgnorableFailure: (cause) =>
				cause instanceof Error &&
				cause.message === "All fibers interrupted without error",
		});
		const entry = harness.supervisor.get({ key: "local" });
		await runClient(entry.getClient());

		expect(
			entry.reportFailure(new Error("All fibers interrupted without error")),
		).toBe(false);
		expect(entry.snapshot().status).toBe("connected");
		expect(harness.disposed).toEqual([]);
		expect(harness.scheduled).toEqual([]);
	});

	test("reconnects immediately when a stable connection moves endpoints", async () => {
		const harness = makeHarness({
			shouldReconnectOnOptionsChange: (previous, next) =>
				previous.token !== next.token,
		});
		const entry = harness.supervisor.get({
			key: "paired-device",
			token: "old",
		});
		await runClient(entry.getClient());

		const updated = harness.supervisor.get({
			key: "paired-device",
			token: "new",
		});
		await waitUntil(() => updated.snapshot().generation === 2);

		expect(harness.created.map(({ token }) => token)).toEqual(["old", "new"]);
		expect(harness.disposed).toEqual([1]);
	});

	test("a new route generation recovers an entry after retries are exhausted", async () => {
		let available = false;
		const harness = makeHarness({
			maxAutomaticAttempts: 1,
			shouldReconnectOnOptionsChange: (previous, next) =>
				previous.routeGeneration !== next.routeGeneration,
			createClient: async () => {
				if (!available) throw new Error("old Wi-Fi route unavailable");
				return { client: { id: 1 }, dispose: async () => undefined };
			},
		});
		const entry = harness.supervisor.get({
			key: "paired-device",
			routeGeneration: 1,
		});
		await expect(runClient(entry.getClient())).rejects.toThrow(
			"old Wi-Fi route unavailable",
		);
		expect(entry.snapshot().status).toBe("error");

		available = true;
		const moved = harness.supervisor.get({
			key: "paired-device",
			routeGeneration: 2,
		});
		await waitUntil(() => moved.snapshot().status === "connected");

		expect(moved.snapshot()).toMatchObject({ status: "connected", attempt: 0 });
	});

	test("accepts only one stream failure report per connected generation", async () => {
		const harness = makeHarness();
		const entry = harness.supervisor.get({ key: "remote" });
		await runClient(entry.getClient());

		expect(entry.reportFailure(new Error("first stream failed"), 1)).toBe(true);
		expect(entry.reportFailure(new Error("sibling stream failed"), 1)).toBe(
			false,
		);
		expect(entry.snapshot()).toMatchObject({
			status: "reconnecting",
			generation: 1,
			attempt: 1,
		});
		expect(harness.scheduled).toHaveLength(1);
	});

	test("supervises local, api, and SSH generations independently", async () => {
		const harness = makeHarness();
		const local = harness.supervisor.get({ key: "local" });
		const api = harness.supervisor.get({ key: "api" });
		const ssh = harness.supervisor.get({ key: "ssh" });
		await Promise.all([
			runClient(local.getClient()),
			runClient(api.getClient()),
			runClient(ssh.getClient()),
		]);

		expect(local.reportFailure(new Error("local stream closed"), 1)).toBe(true);
		expect(harness.supervisor.snapshots()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					key: "local",
					status: "reconnecting",
					generation: 1,
				}),
				expect.objectContaining({
					key: "api",
					status: "connected",
					generation: 1,
				}),
				expect.objectContaining({
					key: "ssh",
					status: "connected",
					generation: 1,
				}),
			]),
		);

		harness.scheduled[0]?.fn();
		await waitUntil(() => local.snapshot().generation === 2);
		expect(api.snapshot().generation).toBe(1);
		expect(ssh.snapshot().generation).toBe(1);
	});

	test("ignores duplicate failure reports while a retry is already owned", async () => {
		const harness = makeHarness({
			createClient: async () => {
				throw new Error("socket did not open");
			},
		});
		const entry = harness.supervisor.get({ key: "remote" });

		await expect(runClient(entry.getClient())).rejects.toThrow(
			"socket did not open",
		);
		expect(entry.snapshot()).toMatchObject({
			status: "reconnecting",
			attempt: 1,
		});

		expect(entry.reportFailure(new Error("same failed client"))).toBe(false);
		expect(entry.snapshot()).toMatchObject({
			status: "reconnecting",
			attempt: 1,
		});
		expect(harness.scheduled).toHaveLength(1);
	});

	test("owns stable-id command redispatch across reconnects", async () => {
		const harness = makeHarness({
			isRetryableCommandError: (cause) =>
				cause instanceof Error && cause.message === "socket closed",
		});
		const entry = harness.supervisor.get({ key: "remote" });
		await runClient(entry.getClient());
		const attemptedWith: number[] = [];
		const receipt = entry.dispatchCommand("command-1", async (client) => {
			attemptedWith.push(client.id);
			if (client.id === 1) throw new Error("socket closed");
			return client.id;
		});

		await waitUntil(() => harness.scheduled.length === 1);
		harness.scheduled[0]?.fn();

		await expect(receipt).resolves.toBe(2);
		expect(attemptedWith).toEqual([1, 2]);
	});

	test("disposes a client that resolves after removal", async () => {
		const gate = deferred<{
			readonly client: Client;
			readonly dispose: () => Promise<void>;
		}>();
		const started = deferred<void>();
		let disposed = false;
		const harness = makeHarness({
			createClient: () => {
				started.resolve();
				return gate.promise;
			},
		});
		const entry = harness.supervisor.get({ key: "local" });
		const pending = runClient(entry.getClient());
		await started.promise;
		const removal = entry.remove();
		gate.resolve({
			client: { id: 1 },
			dispose: async () => {
				disposed = true;
			},
		});

		await expect(pending).rejects.toThrow("connection superseded");
		await removal;
		expect(disposed).toBe(true);
		expect(harness.supervisor.snapshots()).toEqual([]);
	});

	test("disposes all active entries", async () => {
		const harness = makeHarness();
		await Promise.all([
			runClient(harness.supervisor.get({ key: "a" }).getClient()),
			runClient(harness.supervisor.get({ key: "b" }).getClient()),
		]);

		await harness.supervisor.dispose();

		expect(harness.disposed).toEqual([1, 2]);
		expect(harness.supervisor.snapshots()).toEqual([]);
	});
	test("reconnects while an old same-key client is still closing", async () => {
		const closed = deferred<void>();
		let id = 0;
		const harness = makeHarness({
			createClient: async () => {
				const client = { id: ++id };
				return {
					client,
					dispose: () => (client.id === 1 ? closed.promise : Promise.resolve()),
				};
			},
		});
		const previous = harness.supervisor.get({ key: "cloud" });
		await runClient(previous.getClient());
		const removal = harness.supervisor.remove({ key: "cloud" });
		const current = harness.supervisor.get({ key: "cloud" });
		expect(current).not.toBe(previous);
		expect(await runClient(current.getClient())).toEqual({ id: 2 });
		closed.resolve();
		await removal;
		expect(harness.supervisor.get({ key: "cloud" })).toBe(current);
		await expect(runClient(previous.getClient())).rejects.toThrow(
			"connection removed",
		);
		await harness.supervisor.dispose();
	});
	test("removing a missing connection does not create an entry", async () => {
		const harness = makeHarness();
		await harness.supervisor.remove({ key: "missing" });
		expect(harness.created).toEqual([]);
		expect(harness.supervisor.snapshots()).toEqual([]);
	});
});

test.each([
	"retry",
	"remove",
	"offline",
])("aborts in-flight creation on %s and disposes late sessions", async (action) => {
	const started = deferred<void>();
	const late = deferred<{ client: Client; dispose: () => Promise<void> }>();
	let signal: AbortSignal | undefined;
	let disposed = 0;
	const harness = makeHarness({
		createClient: async (_options, attemptSignal) => {
			if (signal) return { client: { id: 2 }, dispose: async () => {} };
			signal = attemptSignal;
			started.resolve();
			return late.promise;
		},
	});
	const entry = harness.supervisor.get({ key: "device" });
	const pending = runClient(entry.getClient());
	const rejected = expect(pending).rejects.toThrow("superseded");
	await started.promise;
	if (action === "retry") entry.retryNow();
	else if (action === "remove") await entry.remove();
	else harness.supervisor.setOnline(false);
	expect(signal?.aborted).toBe(true);
	late.resolve({
		client: { id: 1 },
		dispose: async () => {
			disposed++;
		},
	});
	await rejected;
	expect(disposed).toBe(1);
	await harness.supervisor.dispose();
});

test("late validation cannot install a superseded client or clear its replacement", async () => {
	const started = deferred<void>();
	const finish = deferred<void>();
	const harness = makeHarness({
		validateClient: async (client) => {
			if (client.id === 1) {
				started.resolve();
				await finish.promise;
			}
		},
	});
	const entry = harness.supervisor.get({ key: "device" });
	const pending = runClient(entry.getClient());
	const rejected = expect(pending).rejects.toThrow("superseded");
	await started.promise;
	entry.retryNow();
	expect(await runClient(entry.getClient())).toEqual({ id: 2 });
	finish.resolve();
	await rejected;
	expect(await runClient(entry.getClient())).toEqual({ id: 2 });
	expect(harness.disposed).toEqual([1]);
	await harness.supervisor.dispose();
	expect(harness.disposed).toEqual([1, 2]);
});

describe("session health", () => {
	test("replaces a lost stable session at once without counting a failure", async () => {
		let now = 0;
		const harness = makeHarness({ now: () => now });
		const entry = harness.supervisor.get({ key: "remote" });
		await runClient(entry.getClient());
		now = 25_000;

		expect(entry.reportFailure(new Error("socket closed"), 1)).toBe(true);
		expect(harness.scheduled).toHaveLength(0);
		await waitUntil(() => entry.snapshot().generation === 2);
		expect(entry.snapshot()).toMatchObject({
			status: "connected",
			attempt: 0,
			error: null,
		});
	});

	test("keeps backing off when sessions drop right after connecting", async () => {
		const harness = makeHarness({ now: () => 0 });
		const entry = harness.supervisor.get({ key: "remote" });
		await runClient(entry.getClient());

		entry.reportFailure(new Error("dropped"), 1);
		harness.scheduled[0]?.fn();
		await waitUntil(() => entry.snapshot().generation === 2);
		entry.reportFailure(new Error("dropped again"), 2);

		expect(harness.scheduled.map(({ delayMs }) => delayMs)).toEqual([
			1_000, 2_000,
		]);
		expect(entry.snapshot()).toMatchObject({
			status: "reconnecting",
			attempt: 2,
		});
	});

	test("keeps a session that answers the health probe", async () => {
		const harness = makeHarness({ validateClient: async () => undefined });
		const entry = harness.supervisor.get({ key: "remote" });
		await runClient(entry.getClient());

		await expect(entry.checkHealth(3_000)).resolves.toBe("healthy");
		expect(entry.snapshot()).toMatchObject({
			status: "connected",
			generation: 1,
		});
		expect(harness.disposed).toEqual([]);
	});

	test("replaces a session that stops answering", async () => {
		const harness = makeHarness({
			validateClient: (client) =>
				client.id === 1 && probing
					? new Promise<void>(() => undefined)
					: Promise.resolve(),
		});
		let probing = false;
		const entry = harness.supervisor.get({ key: "remote" });
		await runClient(entry.getClient());
		probing = true;

		const health = entry.checkHealth(3_000);
		await waitUntil(() => harness.scheduled.length === 1);
		expect(harness.scheduled[0]?.delayMs).toBe(3_000);
		harness.scheduled[0]?.fn();

		await expect(health).resolves.toBe("replaced");
		await waitUntil(() => entry.snapshot().generation === 2);
		expect(harness.disposed).toEqual([1]);
		expect(entry.snapshot()).toMatchObject({ status: "connected", attempt: 0 });
	});

	test("skips the remaining backoff when the app resumes", async () => {
		let fail = true;
		const harness = makeHarness({
			createClient: async () => {
				if (fail) throw new Error("network down");
				return { client: { id: 1 }, dispose: async () => undefined };
			},
		});
		const entry = harness.supervisor.get({ key: "remote" });
		await expect(runClient(entry.getClient())).rejects.toThrow("network down");
		fail = false;

		await expect(entry.checkHealth(3_000)).resolves.toBe("pending");
		expect(harness.scheduled[0]?.cancelled).toBe(true);
		await waitUntil(() => entry.snapshot().status === "connected");
	});
});

describe("probe-confirmed failures", () => {
	test("keeps a healthy session when a reported failure is stale", async () => {
		const harness = makeHarness({
			confirmFailuresWithProbe: true,
			validateClient: async () => undefined,
		});
		const entry = harness.supervisor.get({ key: "remote" });
		await runClient(entry.getClient());

		expect(entry.reportFailure(new Error("old socket closed"))).toBe(true);
		await Promise.resolve();
		await Promise.resolve();

		expect(entry.snapshot()).toMatchObject({
			status: "connected",
			generation: 1,
		});
		expect(harness.disposed).toEqual([]);
	});

	test("replaces a session whose probe fails", async () => {
		let dead = false;
		const harness = makeHarness({
			confirmFailuresWithProbe: true,
			validateClient: async () => {
				if (dead) throw new Error("socket closed");
			},
		});
		const entry = harness.supervisor.get({ key: "remote" });
		await runClient(entry.getClient());
		dead = true;

		entry.reportFailure(new Error("stream failed"));
		await waitUntil(() => harness.disposed.length === 1);
		expect(entry.snapshot()).toMatchObject({
			status: "reconnecting",
			attempt: 1,
		});
	});

	test("probes once for a burst of failures", async () => {
		let probes = 0;
		const harness = makeHarness({
			confirmFailuresWithProbe: true,
			validateClient: async () => {
				probes += 1;
			},
		});
		const entry = harness.supervisor.get({ key: "remote" });
		await runClient(entry.getClient());
		probes = 0;

		entry.reportFailure(new Error("a"));
		entry.reportFailure(new Error("b"));
		entry.reportFailure(new Error("c"));
		await Promise.resolve();

		expect(probes).toBe(1);
	});

	test("replaces the session on demand without counting a failure", async () => {
		const harness = makeHarness();
		const entry = harness.supervisor.get({ key: "remote" });
		await runClient(entry.getClient());

		entry.replaceSession();
		await waitUntil(() => entry.snapshot().generation === 2);
		expect(entry.snapshot()).toMatchObject({ status: "connected", attempt: 0 });
		expect(harness.disposed).toEqual([1]);
		expect(harness.scheduled).toHaveLength(0);
	});
});

test("old probes cannot suppress failures or clear probes on a replacement session", async () => {
	const oldProbe = deferred<void>();
	const newProbe = deferred<void>();
	let probing = false;
	let newProbeCalls = 0;
	const harness = makeHarness({
		confirmFailuresWithProbe: true,
		validateClient: (client) => {
			if (!probing) return Promise.resolve();
			if (client.id === 1) return oldProbe.promise;
			if (client.id === 2) {
				newProbeCalls += 1;
				return newProbe.promise;
			}
			return Promise.resolve();
		},
	});
	const entry = harness.supervisor.get({ key: "remote" });
	await runClient(entry.getClient());
	probing = true;
	entry.reportFailure(new Error("old failure"));
	probing = false;
	entry.replaceSession();
	await waitUntil(() => entry.snapshot().generation === 2);
	probing = true;
	newProbeCalls = 0;
	entry.reportFailure(new Error("replacement failed"));
	expect(newProbeCalls).toBe(1);
	oldProbe.resolve(undefined);
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	entry.reportFailure(new Error("same replacement failed again"));
	expect(newProbeCalls).toBe(1);
	newProbe.reject(new Error("replacement socket closed"));
	await waitUntil(() => harness.disposed.includes(2));
	expect(entry.snapshot().status).toBe("reconnecting");
});
