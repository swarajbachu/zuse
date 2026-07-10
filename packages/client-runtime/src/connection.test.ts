import { Context, Effect, Layer } from "effect";
import { describe, expect, test } from "vitest";

import { makeManagedClientSession } from "./connection.js";

class Value extends Context.Service<Value, number>()("test/Value") {}

describe("managed client session", () => {
	test("provides the protocol layer and releases it exactly once", async () => {
		let releases = 0;
		const layer = Layer.effect(
			Value,
			Effect.acquireRelease(Effect.succeed(42), () =>
				Effect.sync(() => releases++),
			),
		);
		const session = await makeManagedClientSession(layer, () => Value);

		expect(session.client).toBe(42);
		await session.dispose();
		expect(releases).toBe(1);
	});

	test("releases the runtime when client construction fails", async () => {
		let releases = 0;
		const layer = Layer.effect(
			Value,
			Effect.acquireRelease(Effect.succeed(42), () =>
				Effect.sync(() => releases++),
			),
		);

		await expect(
			makeManagedClientSession(layer, () => Effect.fail(new Error("boom"))),
		).rejects.toThrow("boom");
		expect(releases).toBe(1);
	});
});
