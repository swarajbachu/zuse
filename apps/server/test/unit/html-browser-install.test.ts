import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { isChromiumInstalled } from "../../src/html-render/preview-browser.ts";

it("does not launch a partially extracted Chromium executable", async () => {
	const dir = await mkdtemp(join(tmpdir(), "zuse-chrome-install-"));
	try {
		const root = join(dir, "chromium-1234");
		await mkdir(join(root, "chrome-linux64"), { recursive: true });
		const executable = join(root, "chrome-linux64", "chrome");
		await writeFile(executable, "partial");
		expect(isChromiumInstalled(executable)).toBe(false);
		await writeFile(join(root, "INSTALLATION_COMPLETE"), "");
		expect(isChromiumInstalled(executable)).toBe(true);
		expect(isChromiumInstalled(join(root, "missing"))).toBe(false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
