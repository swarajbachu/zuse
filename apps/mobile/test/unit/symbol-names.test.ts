import { readFileSync } from "node:fs";
import type { SFSymbol } from "expo-symbols";
import { describe, expect, test } from "vitest";
import {
	materialSymbolNames,
	platformSymbolName,
} from "../../src/lib/symbol-names";

describe("platform symbol names", () => {
	test("preserves iOS glyphs and provides Android and web equivalents", () => {
		for (const [ios, material] of Object.entries(materialSymbolNames)) {
			expect(platformSymbolName(ios as SFSymbol)).toEqual({
				ios,
				android: material,
				web: material,
			});
		}
	});
	test("covers settings and onboarding glyphs", () => {
		const settings = readFileSync(
			`${process.cwd()}/src/components/settings-screen.tsx`,
			"utf8",
		);
		for (const match of settings.matchAll(/symbol="([^"]+)"/g)) {
			expect(materialSymbolNames[match[1] as SFSymbol]).toBeDefined();
		}
		for (const name of [
			"chevron.left",
			"chevron.right",
			"checkmark.circle.fill",
			"cloud.fill",
			"wifi",
		] as const) {
			expect(materialSymbolNames[name]).toBeDefined();
		}
	});
	test("keeps an unmapped symbol visible on other platforms", () => {
		expect(platformSymbolName("star.fill")).toEqual({
			ios: "star.fill",
			android: "help",
			web: "help",
		});
	});
});
