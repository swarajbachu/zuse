import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertCloudRuntimeDataLock } from "../../src/api/cloud-runtime-lock.ts";

describe("canonical runtime data lifetime lock", () => {
	it("rejects a claimed descriptor without an inherited flock", () => {
		expect(() => assertCloudRuntimeDataLock("/tmp", "999999")).toThrow(
			"data_lock_missing",
		);
	});
	it("requires the actual exclusive lock on the canonical inode across exec", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-runtime-lock-"));
		const module = new URL(
			"../../src/api/cloud-runtime-lock.ts",
			import.meta.url,
		).href;
		const program = `import { assertCloudRuntimeDataLock } from ${JSON.stringify(module)}; assertCloudRuntimeDataLock(process.argv[1], '19'); console.log('locked');`;
		try {
			const run = (script: string) =>
				execFileSync(
					"bash",
					["-c", script, "lock-test", directory, process.execPath, program],
					{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
				);
			expect(
				run(
					'exec 19>"$1/.workspace-runtime.lock"; flock -x 19; exec "$2" --experimental-strip-types --input-type=module -e "$3" "$1"',
				),
			).toContain("locked");
			expect(() =>
				run(
					'exec 19>"$1/.workspace-runtime.lock"; exec "$2" --experimental-strip-types --input-type=module -e "$3" "$1"',
				),
			).toThrow();
			expect(() =>
				run(
					'touch "$1/.workspace-runtime.lock"; exec 19>"$1/other.lock"; flock -x 19; exec "$2" --experimental-strip-types --input-type=module -e "$3" "$1"',
				),
			).toThrow();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
