import { expect, it } from "vitest";
import { DoubleEscape } from "../../src/composer/double-escape.ts";

it("stops only after a quick deliberate double press", () => {
	const gate = new DoubleEscape();
	const doc = {};
	expect(gate.press(doc, 0)).toBe(false);
	expect(gate.press(doc, 100)).toBe(true);
	expect(gate.press(doc, 200)).toBe(false);
	expect(gate.press(doc, 800)).toBe(false);
	expect(gate.press(doc, 900)).toBe(true);
});
it("resets on editing, another key, repeated keys, or leaving the editor", () => {
	const gate = new DoubleEscape();
	const doc = {};
	expect(gate.press(doc, 0)).toBe(false);
	expect(gate.press({}, 100)).toBe(false);
	gate.reset();
	expect(gate.press(doc, 150)).toBe(false);
	gate.reset();
	expect(gate.press(doc, 200)).toBe(false);
	expect(gate.press(doc, 300)).toBe(true);
});
