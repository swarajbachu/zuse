import { describe, expect, test } from "vitest";

import { FILE_ICON_XML } from "../../../src/lib/icons/file-icons.generated";
import { resolveFileIconToken } from "../../../src/lib/icons/resolve";

describe("shared file icons", () => {
	test("matches structured-tree file types and compound extensions", () => {
		expect(resolveFileIconToken("src/App.tsx")).toBe("react");
		expect(resolveFileIconToken("src/index.ts")).toBe("typescript");
		expect(resolveFileIconToken("README.md")).toBe("markdown");
		expect(resolveFileIconToken("archive.unknown")).toBe("default");
	});

	test("ships every resolved glyph as native SVG XML", () => {
		for (const path of ["App.tsx", "index.ts", "README.md", "unknown.file"]) {
			const xml = FILE_ICON_XML[resolveFileIconToken(path)];
			expect(xml).toMatch(/^<svg viewBox=/);
		}
	});
});
