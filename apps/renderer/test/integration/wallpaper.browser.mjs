import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite-plus";

// Real IndexedDB and image decoding: verify reloads and failed writes preserve
// the last committed wallpaper. No backend or user data is involved.
const root = resolve(import.meta.dirname, "../..");
const cacheDir = await mkdtemp(join(tmpdir(), "zuse-wallpaper-test-"));
const server = await createServer({
	root,
	configFile: resolve(root, "vite.config.ts"),
	cacheDir,
	server: { host: "127.0.0.1", port: 15801, strictPort: false, hmr: false },
	plugins: [
		{
			name: "wallpaper-probe",
			configureServer(server) {
				server.middlewares.use("/__wallpaper", async (_request, response) => {
					response.setHeader("Content-Type", "text/html");
					response.end(
						await server.transformIndexHtml(
							"/__wallpaper.html",
							'<div id="root"></div><script type="module" src="/@id/__x00__wallpaper-probe"></script>',
						),
					);
				});
			},
			resolveId: (id) => (id === "\0wallpaper-probe" ? id : undefined),
			load(id) {
				if (id !== "\0wallpaper-probe") return;
				return `
				import React from 'react';
				import {createRoot} from 'react-dom/client';
				import * as wallpaper from '/src/lib/wallpaper.ts';
				window.wallpaper = wallpaper;
				function Probe() {
					const state = wallpaper.useWallpaper();
					return React.createElement('output', null, JSON.stringify(state));
				}
				createRoot(document.getElementById('root')).render(React.createElement(Probe));
			`;
			},
		},
	],
});
let browser;
try {
	await server.listen();
	browser = await chromium.launch({
		headless: true,
		args: ["--disable-dev-shm-usage"],
		...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
			? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
			: {}),
	});
	const page = await browser.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(
		`http://127.0.0.1:${server.httpServer.address().port}/__wallpaper`,
	);
	const state = () => page.locator("output").textContent().then(JSON.parse);
	const settled = () =>
		page.waitForFunction(() => {
			const s = JSON.parse(
				document.querySelector("output")?.textContent || "{}",
			);
			return s.loaded && !s.busy;
		});
	await settled();
	assert.equal((await state()).url, null);
	await page.evaluate(async () => {
		const canvas = document.createElement("canvas");
		canvas.width = 3000;
		canvas.height = 1500;
		const ctx = canvas.getContext("2d");
		ctx.fillStyle = "#8957ab";
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		const blob = await new Promise((resolve) => canvas.toBlob(resolve));
		await window.wallpaper.uploadWallpaper(
			new File([blob], "wallpaper.png", { type: "image/png" }),
		);
	});
	await settled();
	assert.ok((await state()).url.startsWith("blob:"));
	const dimensions = await page.evaluate(async () => {
		const image = new Image();
		image.src = JSON.parse(document.querySelector("output").textContent).url;
		await image.decode();
		return [image.naturalWidth, image.naturalHeight];
	});
	assert.deepEqual(dimensions, [2560, 1280]);

	const renderedPixels = () =>
		page.evaluate(async () => {
			const image = new Image();
			image.src = JSON.parse(document.querySelector("output").textContent).url;
			await image.decode();
			const canvas = document.createElement("canvas");
			canvas.width = canvas.height = 16;
			const context = canvas.getContext("2d");
			context.drawImage(image, 0, 0);
			return Array.from(context.getImageData(0, 0, 16, 16).data);
		});
	const pixels = await renderedPixels();
	const colors = new Set();
	let nonRepeatingPixels = 0;
	for (let y = 0; y < 16; y++) {
		for (let x = 0; x < 16; x++) {
			const pixel = pixels.slice((y * 16 + x) * 4, (y * 16 + x) * 4 + 3);
			colors.add(pixel.join(","));
			assert.ok(pixel.every((channel) => channel % 85 === 0));
			const repeat = ((y % 8) * 16 + (x % 8)) * 4;
			if (pixel.join() !== pixels.slice(repeat, repeat + 3).join())
				nonRepeatingPixels++;
		}
	}
	assert.ok(colors.size > 1, "Desktop upload must produce dither texture");
	assert.ok(
		nonRepeatingPixels > 16,
		"6×6 crosses must not repeat on an 8px grid",
	);
	await page.reload();
	await settled();
	assert.deepEqual(
		await renderedPixels(),
		pixels,
		"Reload must not dither twice",
	);

	await page.evaluate(() => window.wallpaper.setWallpaperOpacity(0.4));
	await page.reload();
	await settled();
	assert.equal((await state()).opacity, 0.4);
	assert.ok((await state()).url.startsWith("blob:"));
	const previousUrl = (await state()).url;
	await page.evaluate(() =>
		window.wallpaper.uploadWallpaper(
			new File(["invalid"], "bad.png", { type: "image/png" }),
		),
	);
	await settled();
	assert.equal((await state()).url, previousUrl);
	assert.ok((await state()).error);
	await page.evaluate(async () => {
		const original = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = () => {
			throw new DOMException("Storage full", "QuotaExceededError");
		};
		try {
			await window.wallpaper.setWallpaperOpacity(0.5);
		} finally {
			IDBObjectStore.prototype.put = original;
		}
	});
	await settled();
	assert.equal((await state()).opacity, 0.4);
	assert.ok((await state()).error);
	await page.reload();
	await settled();
	assert.equal((await state()).opacity, 0.4);

	// Simulate a wallpaper saved before automatic dithering was introduced.
	for (const previousVersion of [0, 1, 2]) {
		await page.evaluate(async (previousVersion) => {
			const database = await new Promise((resolve, reject) => {
				const request = indexedDB.open("zuse-wallpaper", 1);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			await new Promise((resolve, reject) => {
				const transaction = database.transaction("wallpaper", "readwrite");
				const store = transaction.objectStore("wallpaper");
				const request = store.get("current");
				request.onsuccess = () =>
					store.put(
						previousVersion === 0
							? { image: request.result.source, opacity: 0.25 }
							: { ...request.result, processingVersion: previousVersion },
						"current",
					);
				transaction.oncomplete = resolve;
				transaction.onerror = () => reject(transaction.error);
			});
			database.close();
		}, previousVersion);
		await page.reload();
		await settled();
		assert.equal((await state()).opacity, 0.5);
		assert.deepEqual(
			await renderedPixels(),
			pixels,
			"Legacy wallpaper is processed from its original",
		);
		await page.reload();
		await settled();
		assert.deepEqual(
			await renderedPixels(),
			pixels,
			"Migration is persisted once",
		);
	}

	await page.evaluate(() => window.wallpaper.removeWallpaper());
	await page.reload();
	await settled();
	assert.equal((await state()).url, null);
	assert.deepEqual(errors, []);
	console.log(
		"Wallpaper browser checks passed: Crosshatch texture, save, opacity, reload, migration, invalid image, failed write, removal.",
	);
} finally {
	await browser?.close();
	await server.close();
	await rm(cacheDir, { recursive: true, force: true });
}
