import { Effect, Fiber, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
	pollCloudWorkspaceCommands,
	replicateCloudWorkspaceEvents,
	retryCloudWorkspaceBootstrap,
} from "../../src/relay/cloud-workspace-runtime.ts";

describe("cloud workspace bootstrap", () => {
	it("retries a transient enrollment failure instead of leaving the runtime detached", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const attemptCount = yield* Ref.make(0);
				const bootstrap = Ref.updateAndGet(
					attemptCount,
					(count) => count + 1,
				).pipe(
					Effect.flatMap((attempt) =>
						attempt === 1
							? Effect.fail(new Error("relay_401"))
							: Effect.succeed("connected"),
					),
				);
				const fiber = yield* Effect.forkDetach(
					retryCloudWorkspaceBootstrap(bootstrap),
				);

				yield* Effect.yieldNow;
				expect(yield* Ref.get(attemptCount)).toBe(1);

				yield* TestClock.adjust("1 second");
				expect(yield* Fiber.join(fiber)).toBe("connected");
				expect(yield* Ref.get(attemptCount)).toBe(2);
			}).pipe(Effect.provide(TestClock.layer())),
		);
	});
});

describe("cloud workspace command polling", () => {
	it("fetches commands queued after the initial startup fetch", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const fetchCount = yield* Ref.make(0);
				const fiber = yield* Effect.forkDetach(
					pollCloudWorkspaceCommands(
						Ref.update(fetchCount, (count) => count + 1),
					),
				);

				yield* Effect.yieldNow;
				expect(yield* Ref.get(fetchCount)).toBe(1);

				yield* TestClock.adjust("1 second");
				expect(yield* Ref.get(fetchCount)).toBeGreaterThanOrEqual(2);

				yield* Fiber.interrupt(fiber);
			}).pipe(Effect.provide(TestClock.layer())),
		);
	});
});

describe("cloud workspace event replication", () => {
	it("batches replayed history instead of serializing one request per event", async () => {
		const batchSizes = await Effect.runPromise(
			Effect.gen(function* () {
				const sent = yield* Ref.make<ReadonlyArray<number>>([]);
				const records = Array.from({ length: 1_001 }, (_, index) => index + 1);
				yield* replicateCloudWorkspaceEvents(
					Stream.fromIterable(records),
					(batch) => Ref.update(sent, (sizes) => [...sizes, batch.length]),
				);
				return yield* Ref.get(sent);
			}),
		);

		expect(batchSizes).toEqual([500, 500, 1]);
	});

	it("flushes a live event without waiting for a full replay batch", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const sent = yield* Ref.make<ReadonlyArray<ReadonlyArray<number>>>([]);
				const fiber = yield* Effect.forkDetach(
					replicateCloudWorkspaceEvents(
						Stream.make(101).pipe(Stream.concat(Stream.never)),
						(batch) => Ref.update(sent, (batches) => [...batches, batch]),
					),
				);

				yield* TestClock.adjust("25 millis");
				expect(yield* Ref.get(sent)).toEqual([[101]]);
				yield* Fiber.interrupt(fiber);
			}).pipe(Effect.provide(TestClock.layer())),
		);
	});

	it("splits a replay before its request body becomes too large", async () => {
		const batches = await Effect.runPromise(
			Effect.gen(function* () {
				const sent = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
				yield* replicateCloudWorkspaceEvents(
					Stream.make("first", "second", "third"),
					(batch) => Ref.update(sent, (items) => [...items, batch]),
					() => 4_000_001,
				);
				return yield* Ref.get(sent);
			}),
		);

		expect(batches).toEqual([["first"], ["second"], ["third"]]);
	});
});
