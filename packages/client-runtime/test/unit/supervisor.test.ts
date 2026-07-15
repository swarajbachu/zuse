import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import {
	type ClientConnectionError,
	createConnectionSupervisor,
} from "../../src/supervisor.js";

type Options = { readonly key: string; readonly token?: string };
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
	maxAutomaticAttempts?: number;
	prepareOptions?: (options: Options) => Promise<Options>;
	createClient?: (options: Options) => Promise<{
		readonly client: Client;
		readonly dispose: () => Promise<void>;
	}>;
	isRetryableCommandError?: (cause: unknown) => boolean;
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
		maxAutomaticAttempts: input?.maxAutomaticAttempts,
		prepareOptions: input?.prepareOptions,
		isRetryableCommandError: input?.isRetryableCommandError,
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
				if (blocked) throw new Error("relay_connect_401");
				return { client: { id: 1 }, dispose: async () => undefined };
			},
		});
		const entry = harness.supervisor.get({ key: "remote" });

		await expect(runClient(entry.getClient())).rejects.toThrow(
			"relay_connect_401",
		);
		expect(entry.snapshot().status).toBe("blockedAuth");
		expect(harness.scheduled).toHaveLength(0);

		blocked = false;
		entry.retryNow();
		await runClient(entry.getClient());
		expect(entry.snapshot().status).toBe("connected");
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
});
