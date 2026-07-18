import { describe, expect, it } from "vitest";

import { selectConnectionBundles } from "../../../src/lib/session-bundles";

describe("selectConnectionBundles", () => {
	it("returns one stable empty snapshot while a connection is loading", () => {
		const first = selectConnectionBundles({}, "missing");
		const second = selectConnectionBundles({}, "missing");

		expect(first).toBe(second);
	});
});
