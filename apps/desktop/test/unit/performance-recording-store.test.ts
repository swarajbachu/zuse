import { mkdtemp, readdir, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { PerformanceRecordingStore } from "../../src/performance-recording-store.ts";

describe("PerformanceRecordingStore", () => {
	test("prunes expired and oldest recordings within the byte budget", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-recordings-"));
		const store = new PerformanceRecordingStore({
			directory,
			maxBytes: 700,
			retentionMs: 24 * 60 * 60 * 1_000,
			now: () => Date.UTC(2026, 6, 31, 12),
		});
		await store.save("old", { payload: "x".repeat(300) });
		const oldPath = join(directory, "old.json");
		await utimes(
			oldPath,
			new Date(Date.UTC(2026, 6, 29)),
			new Date(Date.UTC(2026, 6, 29)),
		);
		await store.save("first", { payload: "y".repeat(300) });
		await store.save("latest", { payload: "z".repeat(300) });

		const files = await readdir(directory);
		expect(files).not.toContain("old.json");
		expect(files).toContain("latest.json");
		const total = (
			await Promise.all(files.map((file) => stat(join(directory, file))))
		).reduce((sum, value) => sum + value.size, 0);
		expect(total).toBeLessThanOrEqual(700);
	});
});
