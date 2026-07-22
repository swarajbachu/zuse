import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ensureExecutableFile } from "../../src/pty/node-pty-helper.ts";

describe("node-pty spawn helper", () => {
	it("repairs an installed helper that has no executable bits", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-pty-helper-"));
		try {
			const helper = join(directory, "spawn-helper");
			await writeFile(helper, "fixture");
			await chmod(helper, 0o666);

			ensureExecutableFile(helper);

			expect((await stat(helper)).mode & 0o111).toBe(0o111);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
