import { describe, expect, it } from "vitest";
import { isInputComposing } from "../../src/lib/input-composition.ts";

describe("IME keyboard ownership", () => {
	it("handles native and React events, including engines reporting 229", () => {
		expect(isInputComposing({ isComposing: true })).toBe(true);
		expect(isInputComposing({ nativeEvent: { isComposing: true } })).toBe(true);
		expect(
			isInputComposing({ nativeEvent: { keyCode: 229, isComposing: false } }),
		).toBe(true);
		expect(isInputComposing({ keyCode: 13, isComposing: false })).toBe(false);
	});
});
