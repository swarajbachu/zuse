import { Deferred, Effect, Queue } from "effect";
import { expect, it } from "vitest";
import { runCloudAutomationPump } from "../../src/api/cloud-automation-mailbox.ts";

it("stays idle without timers and wakes on availability", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const wake = yield* Queue.sliding<void>(1);
				let calls = 0;
				yield* runCloudAutomationPump({
					wake,
					retryMilliseconds: 5,
					cycle: Effect.sync(() => {
						calls++;
						return false;
					}),
				}).pipe(Effect.forkScoped({ startImmediately: true }));
				yield* Effect.sleep(30);
				expect(calls).toBe(1);
				yield* Queue.offer(wake, undefined);
				yield* Effect.sleep(30);
				expect(calls).toBe(2);
			}),
		),
	);
});

it("retries failures and remaining batches, then returns to idle", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const wake = yield* Queue.sliding<void>(1);
				let calls = 0;
				const completed = yield* Deferred.make<void>();
				yield* runCloudAutomationPump({
					wake,
					retryMilliseconds: 5,
					cycle: Effect.suspend(() => {
						calls++;
						return calls === 1
							? Effect.fail("offline")
							: calls === 2
								? Effect.succeed(true)
								: Deferred.succeed(completed, undefined).pipe(Effect.as(false));
					}),
				}).pipe(Effect.forkScoped({ startImmediately: true }));
				yield* Deferred.await(completed).pipe(Effect.timeout("2 seconds"));
				expect(calls).toBe(3);
				yield* Effect.sleep(30);
				expect(calls).toBe(3);
			}),
		),
	);
});
