import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite-plus";

const root = resolve(import.meta.dirname, "../..");
const cacheDir = await mkdtemp(resolve(root, ".chat-images-probe-"));
const server = await createServer({
	optimizeDeps: {
		include: [
			"debug",
			"unified",
			"remark-parse",
			"react-markdown",
			"remark-gfm",
			"rehype-raw",
			"rehype-sanitize",
		],
	},
	root,
	configFile: resolve(root, "vite.config.ts"),
	cacheDir,
	server: {
		host: "127.0.0.1",
		port: 15840,
		strictPort: false,
		open: false,
		hmr: false,
		watch: null,
	},
	plugins: [
		{
			name: "chat-images-probe",
			enforce: "pre",
			configureServer(server) {
				server.middlewares.use("/__gallery", async (_req, res) => {
					res.setHeader("Content-Type", "text/html");
					res.end(
						await server.transformIndexHtml(
							"/__gallery.html",
							'<div id="root"></div><script type="module" src="/@id/__x00__gallery-probe"></script>',
						),
					);
				});
			},
			resolveId(id) {
				if (id === "\0gallery-probe") return id;
			},
			load(id) {
				if (id !== "\0gallery-probe") return;
				return `
 import React from 'react';
 import {createRoot} from 'react-dom/client';
 import {ChatImageGalleryProvider} from '/src/components/chat-image-gallery.tsx';
 import {MarkdownBody} from '/src/components/markdown-body.tsx';
 import '/src/styles.css';
 const source = name => location.origin + '/__image/' + name + '.svg';
 const text = '![First](' + source('first') + ')' + String.fromCharCode(10, 10) + '![Second](' + source('second') + ')';
 const messages = [{content:{_tag:'assistant',text}}, ...Array.from({length:12}, (_,i) => ({content:{_tag:'assistant',text:'![Offscreen '+i+'](' + source('extra'+i) + ')'}}))];
 document.documentElement.classList.add('dark');
 createRoot(document.getElementById('root')).render(React.createElement(ChatImageGalleryProvider,{messages},React.createElement('div',{style:{width:'600px',padding:20}},React.createElement(MarkdownBody,null,text))));
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
		executablePath:
			process.env.CHROME_PATH ||
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	});
	const page = await browser.newPage({
		viewport: { width: 1100, height: 800 },
	});
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/__image/*.svg", (route) =>
		route.fulfill({
			contentType: "image/svg+xml",
			body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="teal"/></svg>',
		}),
	);
	await page.goto(`http://127.0.0.1:${server.config.server.port}/__gallery`);
	const first = page.getByRole("button", {
		name: "View image: First",
		exact: true,
	});
	await first.waitFor({ timeout: 120000 });
	const second = page.getByRole("button", {
		name: "View image: Second",
		exact: true,
	});
	const a = await first.boundingBox();
	const b = await second.boundingBox();
	assert.equal(Math.round(a.y), Math.round(b.y), "two previews share a row");
	assert.ok(a.width <= 240);
	await first.click();
	const dialog = page.getByRole("dialog");
	await dialog.waitFor();
	await dialog
		.getByRole("button", { name: "View image 14: Offscreen 11" })
		.click();
	await dialog.getByText("14 / 14", { exact: true }).waitFor();
	await page.waitForFunction(
		() =>
			document.querySelector('[aria-current="true"]')?.parentElement
				.scrollLeft > 0,
	);
	assert.equal(
		await dialog
			.getByRole("button", { name: "Next image", exact: true })
			.isDisabled(),
		true,
	);
	await page.keyboard.press("ArrowLeft");
	await dialog.getByText("13 / 14", { exact: true }).waitFor();
	const beforeZoom = await dialog
		.locator('img[alt="Offscreen 10"]')
		.first()
		.boundingBox();
	await dialog
		.getByRole("button", { name: "Zoom image", exact: true })
		.first()
		.click();
	assert.ok(
		(await dialog
			.getByRole("button", { name: "Fit image", exact: true })
			.count()) > 0,
	);
	const afterZoom = await dialog
		.locator('img[alt="Offscreen 10"]')
		.first()
		.boundingBox();
	assert.ok(afterZoom.width > beforeZoom.width, "zoom enlarges the image");
	await page.keyboard.press("Escape");
	await dialog.waitFor({ state: "hidden" });
	assert.equal(
		await first.evaluate((element) => element === document.activeElement),
		true,
		"closing restores focus",
	);
	await page.setViewportSize({ width: 340, height: 700 });
	await page.locator("#root > div").evaluate((el) => {
		el.style.width = "100%";
	});
	assert.ok(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	);
	assert.deepEqual(errors, []);
	console.log(
		"PASS: compact paired previews, offscreen transcript images, thumbnails, keyboard navigation, zoom, Escape, narrow viewport",
	);
} finally {
	await browser?.close();
	await server.close();
	await rm(cacheDir, { recursive: true, force: true });
}
