import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
	ApiLinkError,
	apiRuntimeMetadata,
	autoLinkRetryDelayMs,
	autoLinkUntilLinked,
} from "../../src/api/api-link-service.ts";

const originalRuntimeVersion = process.env.ZUSE_RUNTIME_VERSION;

afterEach(() => {
	if (originalRuntimeVersion === undefined) {
		delete process.env.ZUSE_RUNTIME_VERSION;
		return;
	}
	process.env.ZUSE_RUNTIME_VERSION = originalRuntimeVersion;
});

describe("api runtime metadata", () => {
	it("reads the runtime version when the heartbeat is created", () => {
		process.env.ZUSE_RUNTIME_VERSION = "0.1.1";
		expect(apiRuntimeMetadata().runtimeVersion).toBe("0.1.1");

		process.env.ZUSE_RUNTIME_VERSION = "0.1.2";
		expect(apiRuntimeMetadata().runtimeVersion).toBe("0.1.2");
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
