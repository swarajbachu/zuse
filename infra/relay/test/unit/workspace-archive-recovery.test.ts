import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const archiveScript = new URL(
	"../../../cloud-sandboxes/archive-workspace.sh",
	import.meta.url,
);
const restoreScript = new URL(
	"../../../cloud-sandboxes/restore-workspace.sh",
	import.meta.url,
);

describe("workspace archive recovery scripts", () => {
	test("archive produces a checksummed manifest and SQLite online backup", async () => {
		const source = await readFile(archiveScript, "utf8");
		expect(source).toContain(".backup '$staging/archive/zuse.sqlite'");
		expect(source).toContain("PRAGMA integrity_check");
		expect(source).toContain("databaseSha256");
		expect(source).toContain("databaseSizeBytes");
		expect(source).toContain("streamEpoch");
		expect(source).toContain("sourceGeneration");
		expect(source).toContain("sessionHeads");
		expect(source).toContain("sha256sum -c recovery.tar.gz.sha256");
	});

	test("restore validates before atomic promotion and assigns a new epoch", async () => {
		const source = await readFile(restoreScript, "utf8");
		const validate = source.indexOf("set_phase database-validation");
		const promote = source.indexOf("set_phase promotion");
		expect(validate).toBeGreaterThan(0);
		expect(promote).toBeGreaterThan(validate);
		expect(source).toContain("PRAGMA integrity_check");
		expect(source).toContain("ZUSE_RESTORE_STREAM_EPOCH");
		expect(source).toContain("^[0-9a-f]{8}-[0-9a-f]{4}");
		expect(source).toContain("workspace.restore-previous");
		expect(source).toContain('touch "$status_dir/failed"');
	});
});
