import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, test } from "vitest";

import {
	DrainableWorker,
	WorkerClosedError,
} from "../../src/drainable-worker.js";
import {
	KeyedCoalescingWorker,
	KeyedEffectSerialWorker,
} from "../../src/keyed-worker.js";

const deferred = <A>() => {
	let resolve!: (value: A) => void;
	const promise = new Promise<A>((next) => {
		resolve = next;
	});
	return { promise, resolve };
};

describe("DrainableWorker", () => {
	test("serializes operations and drains rejected work", async () => {
		const worker = new DrainableWorker();
		const gate = deferred<void>();
		const order: string[] = [];

		const first = worker.run(async () => {
			order.push("first:start");
			await gate.promise;
			order.push("first:end");
		});
		const second = worker.run(() => {
			order.push("second");
			throw new Error("expected");
		});

		await Promise.resolve();
		expect(order).toEqual(["first:start"]);
		gate.resolve();
		await first;
		await expect(second).rejects.toThrow("expected");
		await worker.drain();
		expect(order).toEqual(["first:start", "first:end", "second"]);
		expect(worker.size).toBe(0);
	});

	test("close rejects new work after draining accepted work", async () => {
		const worker = new DrainableWorker();
		await worker.close();
		await expect(worker.run(() => 1)).rejects.toBeInstanceOf(WorkerClosedError);
	});
});

describe("KeyedCoalescingWorker", () => {
	test("serializes each key, coalesces queued work, and preserves cross-key concurrency", async () => {
		const worker = new KeyedCoalescingWorker<string, string>();
		const gate = deferred<void>();
		const calls: string[] = [];

		const first = worker.run("a", async () => {
			calls.push("a:first");
			await gate.promise;
			return "first";
		});
		const replaced = worker.run("a", () => {
			calls.push("a:replaced");
			return "replaced";
		});
		const latest = worker.run("a", () => {
			calls.push("a:latest");
			return "latest";
		});
		const other = worker.run("b", () => {
			calls.push("b");
			return "other";
		});

		await Promise.resolve();
		expect(calls).toEqual(["a:first", "b"]);
		await expect(other).resolves.toBe("other");
		gate.resolve();
		await expect(first).resolves.toBe("first");
		await expect(Promise.all([replaced, latest])).resolves.toEqual([
			"latest",
			"latest",
		]);
		await worker.drain();
		expect(calls).toEqual(["a:first", "b", "a:latest"]);
	});
});

describe("KeyedEffectSerialWorker", () => {
	test("preserves same-key FIFO order and typed Effect failures", async () => {
		const calls: string[] = [];
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const worker = new KeyedEffectSerialWorker<string>();
				const gate = yield* Deferred.make<void>();
				const first = worker.run(
					"a",
					Effect.gen(function* () {
						calls.push("a:first:start");
						yield* Deferred.await(gate);
						calls.push("a:first:end");
						return "first";
					}),
				);
				const second = worker.run(
					"a",
					Effect.sync(() => {
						calls.push("a:second");
						return "second";
					}),
				);
				const other = worker.run(
					"b",
					Effect.sync(() => {
						calls.push("b:first");
						return "other";
					}),
				);
				const joined = Effect.all([first, second, other], {
					concurrency: "unbounded",
				});
				const fiber = yield* joined.pipe(
					Effect.forkChild({ startImmediately: true }),
				);
				yield* Effect.yieldNow;
				expect(calls).toEqual(["a:first:start", "b:first"]);
				yield* Deferred.succeed(gate, undefined);
				return yield* Fiber.join(fiber);
			}),
		);

		expect(result).toEqual(["first", "second", "other"]);
		expect(calls).toEqual([
			"a:first:start",
			"b:first",
			"a:first:end",
			"a:second",
		]);
	});
});
