import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = (relativePath: string): string =>
	readFileSync(`${process.cwd()}/src/components/${relativePath}`, "utf8");

describe("iOS native menu compatibility", () => {
	test("does not require HStackView from the installed development client", () => {
		for (const file of [
			"selector-row.ios.tsx",
			"model-mode-menu.ios.tsx",
			"model-sheet.ios.tsx",
		]) {
			expect(source(file)).not.toContain("\tHStack,");
			expect(source(file)).not.toContain("<HStack");
		}
	});

	test("uses supported native label primitives for provider artwork", () => {
		const modelSheet = source("model-sheet.ios.tsx");
		expect(modelSheet).toContain("<Label");
		expect(modelSheet).toContain("assetName={PROVIDER_NATIVE_ASSET_NAMES");
		expect(modelSheet).toContain("seedColor={colors.fg}");
		expect(modelSheet).toContain("padding({ trailing: 6 })");
	});

	test("session actions use the native anchored header menu", () => {
		const sessionActions = source("session-actions-menu.ios.tsx");
		expect(sessionActions).toContain("<Host");
		expect(sessionActions).toContain("<Menu");
		expect(sessionActions).toContain("<NativeButton");
		expect(sessionActions).not.toContain("ActionSheetIOS");
		expect(sessionActions).not.toContain("Stack.Toolbar.Menu");
	});
});
