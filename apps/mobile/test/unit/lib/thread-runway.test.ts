import { describe, expect, test } from "vitest";

import { transcriptEndRunwayHeight } from "../../../src/lib/thread-runway";

describe("transcript end runway", () => {
	test("keeps a followed short transcript immediately above the composer", () => {
		expect(transcriptEndRunwayHeight()).toBe(16);
	});

	test("never removes the minimum breathing room on a compact viewport", () => {
		expect(transcriptEndRunwayHeight()).toBeGreaterThanOrEqual(16);
	});
});
