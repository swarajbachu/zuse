import { describe, expect, it } from "vitest";

import { structuralTupleKey } from "../../src/structural-tuple-key.js";

describe("structuralTupleKey", () => {
	it("keeps delimiter-shaped tuples structurally distinct", () => {
		expect(structuralTupleKey("a:b", "c")).not.toBe(
			structuralTupleKey("a", "b:c"),
		);
		expect(structuralTupleKey("a", "b")).toBe(structuralTupleKey("a", "b"));
	});
});
