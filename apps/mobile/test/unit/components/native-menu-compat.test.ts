import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = (relativePath: string): string =>
	readFileSync(`${process.cwd()}/src/components/${relativePath}`, "utf8");

describe("iOS native menu compatibility", () => {
	test("does not require HStackView from the installed development client", () => {
		for (const file of ["selector-row.ios.tsx", "model-mode-menu.ios.tsx"]) {
			expect(source(file)).not.toContain("\tHStack,");
			expect(source(file)).not.toContain("<HStack");
		}
	});
});
