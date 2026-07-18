import { describe, expect, test } from "vitest";

import {
	DARK_SYNTAX,
	MAX_HIGHLIGHT_CHARS,
	tokenizeCodeLine,
} from "../../../src/lib/syntax-highlighting";

describe("mobile syntax highlighting", () => {
	test("colors language tokens while preserving their text", () => {
		const source = 'export const answer = "yes"; // ready';
		const pieces = tokenizeCodeLine(source, DARK_SYNTAX);

		expect(pieces.map((piece) => piece.text).join("")).toBe(source);
		expect(pieces.some((piece) => piece.color === DARK_SYNTAX.keyword)).toBe(
			true,
		);
		expect(pieces.some((piece) => piece.color === DARK_SYNTAX.string)).toBe(
			true,
		);
		expect(pieces.some((piece) => piece.color === DARK_SYNTAX.comment)).toBe(
			true,
		);
	});

	test("bounds work for pathological long lines", () => {
		const pieces = tokenizeCodeLine(
			"x".repeat(MAX_HIGHLIGHT_CHARS + 500),
			DARK_SYNTAX,
		);
		const rendered = pieces.map((piece) => piece.text).join("");

		expect(rendered.length).toBe(MAX_HIGHLIGHT_CHARS + 1);
		expect(rendered.endsWith("…")).toBe(true);
	});
});
