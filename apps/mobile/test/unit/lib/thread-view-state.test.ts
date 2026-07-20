import { describe, expect, it } from "vitest";

import {
	readThreadViewState,
	writeThreadViewState,
} from "../../../src/lib/thread-view-state";

describe("thread view state", () => {
	it("retains independent reader positions per thread", () => {
		writeThreadViewState("planning", {
			mode: "detached",
			offsetY: 420,
			distanceFromBottom: 900,
		});
		writeThreadViewState("build", {
			mode: "following",
			offsetY: 100,
			distanceFromBottom: 0,
		});

		expect(readThreadViewState("planning")).toMatchObject({ offsetY: 420 });
		expect(readThreadViewState("build")).toMatchObject({
			mode: "following",
		});
	});
});
