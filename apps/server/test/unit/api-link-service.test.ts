import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
	ApiLinkError,
	apiRuntimeMetadata,
	autoLinkRetryDelayMs,
	autoLinkUntilLinked,
	heartbeatDelayMs,
	heartbeatUntilInterrupted,
	waitForNextHeartbeat,
} from "../../src/api/api-link-service.ts";

const originalRuntimeVersion = process.env.ZUSE_RUNTIME_VERSION;
const originalAppVersion = process.env.ZUSE_APP_VERSION;

const restoreEnv = (name: string, value: string | undefined): void => {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
};

afterEach(() => {
	restoreEnv("ZUSE_RUNTIME_VERSION", originalRuntimeVersion);
	restoreEnv("ZUSE_APP_VERSION", originalAppVersion);
});

describe("api runtime metadata", () => {
	it("reads the runtime version when the heartbeat is created", () => {
		process.env.ZUSE_RUNTIME_VERSION = "0.1.1";
		expect(apiRuntimeMetadata().runtimeVersion).toBe("0.1.1");

		process.env.ZUSE_RUNTIME_VERSION = "0.1.2";
		expect(apiRuntimeMetadata().runtimeVersion).toBe("0.1.2");
	});

	it("falls back to the desktop app version for the embedded host", () => {
		delete process.env.ZUSE_RUNTIME_VERSION;
		process.env.ZUSE_APP_VERSION = "0.22.1";
		expect(apiRuntimeMetadata().runtimeVersion).toBe("0.22.1");
	});
});

describe("api heartbeat", () => {
	it("retries quickly after a failure and settles back to the interval", () => {
		expect(heartbeatDelayMs(0)).toBe(30_000);
		expect([1, 2, 3].map(heartbeatDelayMs)).toEqual([2_000, 5_000, 10_000]);
		expect(heartbeatDelayMs(4)).toBe(30_000);
	});

	it("waits the full interval while the machine stays awake", async () => {
		let wall = 0;
		const finished = await Effect.runPromise(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					waitForNextHeartbeat(30_000, () => wall),
				);
				yield* Effect.yieldNow;
				for (let tick = 0; tick < 5; tick += 1) {
					wall += 5_000;
					yield* TestClock.adjust("5 seconds");
				}
				const early = fiber.pollUnsafe() !== undefined;
				wall += 5_000;
				yield* TestClock.adjust("5 seconds");
				yield* Fiber.join(fiber);
				return early;
			}).pipe(Effect.provide(TestClock.layer())),
		);
		expect(finished).toBe(false);
	});

	it("returns early when the wall clock jumps because the machine slept", async () => {
		let wall = 0;
		await Effect.runPromise(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					waitForNextHeartbeat(30_000, () => wall),
				);
				yield* Effect.yieldNow;
				// Ten minutes of sleep pass while the first 5s timer is frozen.
				wall += 10 * 60_000;
				yield* TestClock.adjust("5 seconds");
				yield* Fiber.join(fiber);
			}).pipe(Effect.provide(TestClock.layer())),
		);
	});

	it("reports an outage once and recovery after quick retries", async () => {
		const events: string[] = [];
		let beats = 0;
		await Effect.runPromise(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					heartbeatUntilInterrupted(
						Effect.suspend(() => {
							beats += 1;
							return beats === 2 || beats === 3
								? Effect.fail(new ApiLinkError({ reason: "api_503" }))
								: Effect.void;
						}),
						{
							wallClock: () => 0,
							onFailure: (_error, failures) =>
								Effect.sync(() => events.push(`failed:${failures}`)),
							onRecovered: (failures) =>
								Effect.sync(() => events.push(`recovered:${failures}`)),
						},
					),
				);
				// 30s healthy wait, then 2s and 5s quick retries.
				yield* TestClock.adjust("37 seconds");
				yield* Fiber.interrupt(fiber);
			}).pipe(Effect.provide(TestClock.layer())),
		);
		expect(beats).toBe(4);
		expect(events).toEqual(["failed:1", "failed:2", "recovered:2"]);
	});
});

describe("automatic api link retries", () => {
	const limit = new ApiLinkError({ reason: "api_409:computer_limit_reached" });
	const transient = new ApiLinkError({ reason: "api_503" });

	it("backs off transient failures to a minute but waits on a full account", () => {
		expect(autoLinkRetryDelayMs(transient, 0)).toBe(3_000);
		expect(autoLinkRetryDelayMs(transient, 10)).toBe(60_000);
		expect(autoLinkRetryDelayMs(limit, 0)).toBe(600_000);
	});

	it("keeps retrying a full account until a slot frees up", async () => {
		let attempts = 0;
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					autoLinkUntilLinked(
						Effect.suspend(() =>
							++attempts < 3 ? Effect.fail(limit) : Effect.void,
						),
					),
				);
				yield* TestClock.adjust("25 minutes");
				yield* Fiber.join(fiber);
				return attempts;
			}).pipe(Effect.provide(TestClock.layer())),
		);
		expect(result).toBe(3);
	});
});
