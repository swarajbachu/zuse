import { describe, expect, it } from "vitest";

import {
	assertEnvironmentIdentity,
	waitForBounded,
} from "../../src/ssh/environment-service.ts";

describe("SSH environment identity", () => {
	it("accepts first connections and stable reconnects", () => {
		expect(() => assertEnvironmentIdentity(null, "env-a")).not.toThrow();
		expect(() => assertEnvironmentIdentity("env-a", "env-a")).not.toThrow();
	});

	it("rejects reconnecting a profile to different data", () => {
		expect(() => assertEnvironmentIdentity("env-a", "env-b")).toThrow(
			/identity changed/u,
		);
	});
});

describe("SSH environment deadlines", () => {
	it("bounds stalled handshakes", async () => {
		await expect(
			waitForBounded(
				new Promise(() => undefined),
				new AbortController().signal,
				"timed out",
				5,
			),
		).rejects.toThrow("timed out");
	});

	it("cancels pending handshakes", async () => {
		const controller = new AbortController();
		const pending = waitForBounded(
			new Promise(() => undefined),
			controller.signal,
			"timed out",
			1_000,
		);
		controller.abort();
		await expect(pending).rejects.toThrow(/cancelled/u);
	});
});
