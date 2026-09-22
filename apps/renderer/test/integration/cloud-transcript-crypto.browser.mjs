import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const directory = await mkdtemp(join(tmpdir(), "zuse-cloud-crypto-"));
const root = resolve(import.meta.dirname, "../..");
let browser;
const server = createServer(async (request, response) => {
	response.setHeader(
		"Content-Type",
		request.url === "/fixture.js" ? "text/javascript" : "text/html",
	);
	response.end(
		request.url === "/fixture.js"
			? await readFile(join(directory, "fixture.js"))
			: "<!doctype html><title>Cloud transcript stream regression</title>",
	);
});
try {
	execFileSync(
		"bun",
		[
			"build",
			"test/fixtures/cloud-transcript-crypto.ts",
			"--target=browser",
			`--outfile=${join(directory, "fixture.js")}`,
		],
		{ cwd: root, stdio: "pipe" },
	);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	browser = await chromium.launch({
		executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
		headless: true,
		args: ["--no-sandbox"],
	});
	const page = await browser.newPage();
	await page.goto(`http://127.0.0.1:${server.address().port}`);
	console.log(
		JSON.stringify(
			await page.evaluate(async () =>
				Promise.race([
					(await import("/fixture.js")).run(),
					new Promise((_, reject) =>
						setTimeout(
							() =>
								reject(
									new Error("Transcript compression/decompression stalled"),
								),
							5000,
						),
					),
				]),
			),
			null,
			2,
		),
	);
} finally {
	await browser?.close();
	await new Promise((resolve) => server.close(resolve));
	await rm(directory, { recursive: true, force: true });
}
