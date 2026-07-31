import { describe, expect, it } from "vitest";

import { createStoredZip } from "../../src/diagnostics/zip-bundle.ts";

describe("diagnostics zip bundle", () => {
	it("creates a standard zip containing named artifacts", () => {
		const zip = createStoredZip([
			{ name: "manifest.json", data: Buffer.from('{"ok":true}') },
			{ name: "REPORT.md", data: Buffer.from("# Report") },
		]);

		expect(zip.subarray(0, 4).toString("hex")).toBe("504b0304");
		expect(zip.includes(Buffer.from("manifest.json"))).toBe(true);
		expect(zip.includes(Buffer.from("REPORT.md"))).toBe(true);
		expect(zip.subarray(-22, -18).toString("hex")).toBe("504b0506");
	});
});
