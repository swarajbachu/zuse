import { describe, expect, it } from "vitest";

import { shouldMountRightPane } from "../../src/shell/right-pane-lifecycle.ts";

describe("right-pane lifecycle", () => {
	it("keeps browser command handling mounted while the dock is collapsed", () => {
		expect(shouldMountRightPane(false)).toBe(true);
		expect(shouldMountRightPane(true)).toBe(true);
	});
});
