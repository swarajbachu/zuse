import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite-plus";

const root = resolve(import.meta.dirname, "../..");
const directory = await mkdtemp(resolve(root, ".tool-details-probe-"));
const pending = [];
const waiting = [];
let requests = 0;
let browser;
const nextRequest = () =>
	new Promise((resolve) =>
		pending.length ? resolve(pending.shift()) : waiting.push(resolve),
	);
const server = await createServer({
	root,
	configFile: resolve(root, "vite.config.ts"),
	cacheDir: directory,
	server: {
		host: "127.0.0.1",
		port: 15893,
		strictPort: false,
		open: false,
		hmr: false,
		watch: null,
	},
	plugins: [
		{
			name: "deferred-detail-fixture",
			configureServer(server) {
				server.middlewares.use(async (request, response, next) => {
					if (request.url === "/detail") {
						requests++;
						let closed;
						const aborted = new Promise((resolve) => {
							closed = resolve;
						});
						response.on("close", closed);
						response.writeHead(200, { "Content-Type": "application/json" });
						response.flushHeaders();
						const entry = {
							aborted,
							finish: () =>
								response.end(
									JSON.stringify({
										input: { command: "build" },
										result: {
											isError: false,
											output: `complete output marker ${"result ".repeat(5000)}`,
										},
									}),
								),
						};
						const waiter = waiting.shift();
						if (waiter) waiter(entry);
						else pending.push(entry);
						return;
					}
					if (request.url !== "/__probe") {
						next();
						return;
					}
					response.setHeader("Content-Type", "text/html");
					response.end(
						await server.transformIndexHtml(
							"/__probe.html",
							'<!doctype html><title>Deferred tool details</title><script type="module" src="/test/fixtures/deferred-tool-details.tsx"></script>',
						),
					);
				});
			},
		},
	],
});
try {
	await server.listen();
	browser = await chromium.launch({
		executablePath: process.env.CHROME_PATH,
		headless: true,
	});
	const page = await browser.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(
		`http://127.0.0.1:${server.httpServer.address().port}/__probe`,
	);
	const disclosure = page.locator("button[aria-expanded]").first();
	await disclosure.waitFor();
	assert.match(
		await disclosure.textContent(),
		/build/,
		"collapsed command preview disappeared",
	);
	assert.doesNotMatch(
		await page
			.locator('[data-testid="grep"] button[aria-expanded]')
			.textContent(),
		/2/,
		"partial grep preview showed a total count",
	);
	assert.equal(requests, 0, "collapsed tool downloaded detail");
	const firstRequest = nextRequest();
	await disclosure.click();
	const first = await firstRequest;
	await page.getByRole("status").waitFor();
	await disclosure.click();
	await first.aborted;
	assert.equal(requests, 1);
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Network.enable");
	await cdp.send("Network.emulateNetworkConditions", {
		offline: false,
		latency: 400,
		downloadThroughput: 50_000,
		uploadThroughput: 12_500,
	});
	const secondRequest = nextRequest();
	await disclosure.click();
	const second = await secondRequest;
	second.finish();
	await page
		.getByText(/complete output marker/)
		.first()
		.waitFor();
	await disclosure.click();
	await disclosure.click();
	await page
		.getByText(/complete output marker/)
		.first()
		.waitFor();
	assert.equal(requests, 2, "reopening loaded detail repeated the download");
	assert.deepEqual(errors, []);
	console.log(
		"PASS: no collapsed fetch; collapse aborts stalled body; expanded detail loads under 400 ms latency / 400 kbit/s download; reopening reuses loaded detail",
	);
} finally {
	await browser?.close();
	await server.close();
	await rm(directory, { recursive: true, force: true });
}
