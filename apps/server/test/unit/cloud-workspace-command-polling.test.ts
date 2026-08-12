import { Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
	pollCloudWorkspaceCommands,
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
