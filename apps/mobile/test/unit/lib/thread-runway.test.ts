import { describe, expect, test } from "vitest";

import { transcriptEndRunwayHeight } from "../../../src/lib/thread-runway";

describe("transcript end runway", () => {
	test("leaves enough measured space to place the latest turn below the header", () => {
		expect(
			transcriptEndRunwayHeight({
				viewportHeight: 844,
				headerHeight: 102,
				composerHeight: 126,
			}),
		).toBe(592);
	});

	test("never removes the minimum breathing room on a compact viewport", () => {
		expect(
			transcriptEndRunwayHeight({
				viewportHeight: 180,
				headerHeight: 100,
				composerHeight: 100,
			}),
		).toBe(16);
	});
});
