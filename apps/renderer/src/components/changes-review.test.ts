import { describe, expect, test } from "vitest";

import { reviewFingerprint } from "./changes-review.tsx";

describe("reviewFingerprint", () => {
	test("stays stable for the same rendered patch", () => {
		const patch = "@@ -1 +1 @@\n-old\n+new\n";
		expect(reviewFingerprint(patch)).toBe(reviewFingerprint(patch));
	});

	test("changes when the rendered patch changes", () => {
		expect(reviewFingerprint("+first\n")).not.toBe(
			reviewFingerprint("+second\n"),
		);
	});
});
