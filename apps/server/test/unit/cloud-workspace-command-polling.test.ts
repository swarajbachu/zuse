import { Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { pollCloudWorkspaceCommands } from "../../src/relay/cloud-workspace-runtime.ts";

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
