import { describe, expect, test } from "vitest";

import { setConnectionSnapshot } from "../../../src/lib/connection-snapshot-state";

describe("connection snapshot state", () => {
	test("does not publish the identical supervisor snapshot twice", () => {
		const snapshot = {
			status: "offline",
			generation: 4,
			attempt: 0,
			error: null,
		} as never;
		const initial = { local: snapshot };

		expect(setConnectionSnapshot(initial, "local", snapshot)).toBe(initial);
	});
});
