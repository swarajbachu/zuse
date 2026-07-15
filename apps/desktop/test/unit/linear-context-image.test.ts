import { describe, expect, it } from "vitest";

import { isLinearContextImagePath } from "../../src/linear-context-image.ts";

describe("Linear context image protocol", () => {
	it("allows generated issue images", () => {
		expect(
			isLinearContextImagePath(
				"/workspace/.context/linear/team-a1b2/assets/ABC-123/image.png",
			),
		).toBe(true);
	});

	it("rejects traversal targets and non-images", () => {
		expect(
			isLinearContextImagePath("/workspace/.context/linear/secret.png"),
		).toBe(false);
		expect(
			isLinearContextImagePath(
				"/workspace/.context/linear/team-a1b2/assets/ABC-123/notes.txt",
			),
		).toBe(false);
	});
});
