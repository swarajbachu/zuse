import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { afterAll, expect, it } from "vitest";
import {
	HtmlPreviewBrowser,
	htmlPreviewInstaller,
} from "../../src/html-render/preview-browser.ts";

// CI may override this with a provisioned Chromium path. No browser download in tests.
const browser = new HtmlPreviewBrowser({
	executablePath: process.env.ZUSE_TEST_CHROME ?? "/usr/bin/google-chrome",
});
afterAll(() => browser.close());

it("captures interactive HTML in an opaque sandbox and measures responsive content", async () => {
	const html = `<style>body{height:400px}@media(max-width:400px){body{height:600px}}</style><h1>Benchmark</h1><script>console.log('ran');try{parent.document.body.innerHTML='escaped'}catch{console.log('isolated')}</script>`;
	const wide = await browser.preview({ html }, new AbortController().signal);
	expect(wide.contentHeight).toBe(400);
	expect(wide.width).toBe(728);
	expect(wide.consoleMessages.some((message) => message.text === "ran")).toBe(
		true,
	);
	expect(
		wide.consoleMessages.some((message) => message.text === "isolated"),
	).toBe(true);
	expect(
		Buffer.from(wide.screenshot.data, "base64").subarray(1, 4).toString(),
	).toBe("PNG");
	const narrow = await browser.preview(
		{ html, width: 390, appearance: "light" },
		new AbortController().signal,
	);
	expect(narrow.contentHeight).toBe(600);
}, 30_000);

it("blocks local HTTP assets and navigation without contacting the target", async () => {
	let hits = 0;
	const target = createServer((_req, res) => {
		hits++;
		res.end("secret");
	});
	await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
	try {
		const address = target.address();
		if (!address || typeof address === "string") throw new Error("No address");
		const url = `http://127.0.0.1:${address.port}/secret`;
		await browser.preview(
			{
				html: `<img src="${url}"><script src="${url}"></script><iframe src="${url}"></iframe><script>fetch('${url}').catch(()=>console.log('blocked'));try{top.location='${url}'}catch{console.log('navigation blocked')}</script>`,
			},
			new AbortController().signal,
		);
		expect(hits).toBe(0);
	} finally {
		await new Promise<void>((resolve) => target.close(() => resolve()));
	}
}, 30_000);

it("cancels a hung visual and can preview again", async () => {
	const controller = new AbortController();
	const job = browser.preview(
		{ html: "<script>while(true){}</script>" },
		controller.signal,
	);
	const timer = setTimeout(() => controller.abort(), 500);
	try {
		await expect(job).rejects.toThrow();
	} finally {
		clearTimeout(timer);
	}
	const next = await browser.preview(
		{ html: "<h1>Recovered</h1>" },
		new AbortController().signal,
	);
	expect(next.screenshot.data.length).toBeGreaterThan(100);
}, 30_000);

it("reports unavailable Chromium without affecting other preview instances", async () => {
	const missing = new HtmlPreviewBrowser({
		executablePath: "/missing/chromium",
	});
	try {
		await expect(
			missing.preview({ html: "hi" }, new AbortController().signal),
		).rejects.toThrow();
	} finally {
		await missing.close();
	}
});

it("resolves the installed Playwright CLI through its public package export", () => {
	expect(existsSync(htmlPreviewInstaller())).toBe(true);
});
