import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	createStoredZip,
	writeStoredZip,
} from "../../src/diagnostics/zip-bundle.ts";

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

	it("streams stored artifacts into a zip file", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-zip-"));
		try {
			const artifactPath = join(directory, "artifact.json");
			const zipPath = join(directory, "bundle.zip");
			writeFileSync(artifactPath, Buffer.alloc(2 * 1024 * 1024, 97));
			const chunkSizes: number[] = [];
			await writeStoredZip(
				zipPath,
				[{ name: "artifact.json", path: artifactPath }],
				{
					onArtifactChunk: (bytes) => chunkSizes.push(bytes),
				},
			);
			const zip = readFileSync(zipPath);
			expect(zip.subarray(0, 4).toString("hex")).toBe("504b0304");
			expect(zip.includes(Buffer.from("artifact.json"))).toBe(true);
			expect(zip.subarray(-22, -18).toString("hex")).toBe("504b0506");
			expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(64 * 1024);
			expect(chunkSizes.length).toBeGreaterThan(1);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
