import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite-plus";

const root = resolve(import.meta.dirname, "../..");
const cacheDir = await mkdtemp(resolve(root, ".html-visual-probe-"));
const html = await readFile(
	resolve(root, "test/fixtures/benchmark-visual.html"),
	"utf8",
);
const server = await createServer({
	root,
	configFile: resolve(root, "vite.config.ts"),
	cacheDir,
	server: {
		host: "127.0.0.1",
		port: 15925,
		strictPort: false,
		open: false,
		hmr: false,
		watch: null,
	},
	plugins: [
		{
			name: "html-visual-probe",
			enforce: "pre",
			configureServer(server) {
				server.middlewares.use("/__html_visual", async (_req, res) => {
					res.setHeader("Content-Type", "text/html");
					res.end(
						await server.transformIndexHtml(
							"/__html_visual.html",
							'<div id="root"></div><script type="module" src="/@id/__x00__html-visual-probe"></script>',
						),
					);
				});
			},
			resolveId(id, importer) {
				if (id === "\0html-visual-probe") return id;
				if (!importer?.includes("html-visual.tsx")) return;
				if (id.endsWith("/lib/appearance")) return "\0visual-appearance";
				if (id.endsWith("/lib/attachments")) return "\0visual-attachments";
			},
			load(id) {
				if (id === "\0visual-appearance")
					return `import {useSyncExternalStore} from 'react';export const useResolvedAppearance=()=>useSyncExternalStore(cb=>{window.addEventListener('theme',cb);return()=>window.removeEventListener('theme',cb)},()=>window.appearance||'dark');`;
				if (id === "\0visual-attachments")
					return `import {useEffect,useState} from 'react';export const useAttachmentUrl=(ref,id)=>{const [attempt,retry]=useState(0);const [src,setSrc]=useState(null);useEffect(()=>{if(ref){window.reads++;setSrc(window.visualSrc)}},[ref?.sessionId,id,attempt]);return {src:window.failVisual?null:src,failed:!!window.failVisual,retry:()=>{window.failVisual=false;retry(a=>a+1)}}};`;
				if (id === "\0html-visual-probe")
					return `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {HtmlVisual} from '/src/components/html-visual.tsx';
    import {prepareHtmlDocument} from '@zuse/utils/html-document';import '/src/styles.css';
    window.reads=0;window.appearance='dark';document.documentElement.classList.add('dark');
    window.visualSrc='data:text/html;base64,'+btoa(unescape(encodeURIComponent(prepareHtmlDocument(${JSON.stringify(html)}))));
    const root=createRoot(document.getElementById('root'));let count=0;
    window.renderVisual=()=>root.render(React.createElement('main',{style:{maxWidth:780,margin:'36px auto',padding:'0 16px'}},
      React.createElement('p',{style:{color:'var(--muted-foreground)',fontSize:13}},'Zuse · inline visualization'),
      React.createElement(HtmlVisual,{key:'visual',visual:{attachmentId:'saved',title:'Typecheck benchmarks',height:1100},sessionRef:{environmentId:'local',sessionId:'owner'}}),
      React.createElement('p',null,'Streaming reply '+(++count))));
    window.renderVisual();window.mountVisual=()=>{root.render(null);setTimeout(window.renderVisual,50)};
    window.changeTheme=()=>{window.appearance=window.appearance==='dark'?'light':'dark';document.documentElement.classList.toggle('dark',window.appearance==='dark');window.dispatchEvent(new Event('theme'))};
   `;
			},
		},
	],
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/__html_visual`;
if (process.argv.includes("--serve")) {
	console.log(url);
	const shutdown = async () => {
		await server.close();
		await rm(cacheDir, { recursive: true, force: true });
		process.exit(0);
	};
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);
} else {
	let browser;
	try {
		browser = await chromium.launch({
			executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
			headless: true,
			args: ["--no-sandbox"],
		});
		const page = await browser.newPage({
			viewport: { width: 1100, height: 1000 },
		});
		const errors = [];
		page.on("pageerror", (e) => errors.push(e.message));
		await page.goto(url);
		const frame = page.frameLocator("iframe").first();
		await frame
			.getByRole("heading", { name: "Typecheck benchmarks", exact: true })
			.waitFor();
		assert.equal(
			await page.locator("iframe").getAttribute("sandbox"),
			"allow-scripts",
		);
		const inner = () =>
			page.frames().find((f) => f.parentFrame() === page.mainFrame());
		const instance = await inner().evaluate(() => window.visualInstance);
		assert.equal(typeof instance, "string");
		await frame.getByRole("button", { name: "Show methodology" }).click();
		assert.equal(await frame.locator("#method").isVisible(), true);
		await page.evaluate(() => window.renderVisual());
		assert.equal(await inner().evaluate(() => window.visualInstance), instance);
		assert.equal(await page.evaluate(() => window.reads), 1);
		await page.evaluate(() => window.changeTheme());
		await page.waitForFunction(
			() => document.documentElement.classList.contains("dark") === false,
		);
		await page.waitForTimeout(100);
		assert.equal(
			await inner().evaluate(
				() => getComputedStyle(document.documentElement).colorScheme,
			),
			"light",
		);
		assert.equal(await inner().evaluate(() => window.visualInstance), instance);
		const beforeHeight = await page
			.locator("iframe")
			.evaluate((el) => el.style.height);
		await page.evaluate(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					source: window,
					data: { type: "zuse:visual-size", height: 2000 },
				}),
			),
		);
		assert.equal(
			await page.locator("iframe").evaluate((el) => el.style.height),
			beforeHeight,
		);
		assert.equal(
			await inner().evaluate(() => {
				try {
					return parent.document.body.innerHTML;
				} catch {
					return "isolated";
				}
			}),
			"isolated",
		);
		await page
			.getByRole("button", { name: "Expand Typecheck benchmarks" })
			.click();
		await page.getByRole("dialog").waitFor();
		assert.equal(await page.locator("iframe").count(), 2);
		await page
			.getByRole("button", { name: "Close", exact: true })
			.first()
			.click();
		await page.getByRole("dialog").waitFor({ state: "hidden" });
		await page.evaluate(() => window.changeTheme());
		const screenshots = process.env.ZUSE_TEST_SCREENSHOT_DIR;
		if (screenshots) {
			await mkdir(screenshots, { recursive: true });
			await page.screenshot({
				path: resolve(screenshots, "html-visual-wide.png"),
				fullPage: true,
			});
		}
		await page.setViewportSize({ width: 390, height: 1000 });
		await page.waitForTimeout(150);
		assert.equal(
			await inner().evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
			true,
		);
		if (screenshots)
			await page.screenshot({
				path: resolve(screenshots, "html-visual-narrow.png"),
				fullPage: true,
			});
		await page.evaluate(() => {
			window.failVisual = true;
			window.mountVisual();
		});
		await page.getByRole("button", { name: "Retry preview" }).click();
		await page
			.frameLocator("iframe")
			.first()
			.getByRole("heading", { name: "Typecheck benchmarks", exact: true })
			.waitFor();
		assert.equal(errors.length, 0, errors.join("\n"));
		console.log(
			"HTML visual browser checks passed: interaction, theme, stable mount, isolation, expansion, narrow layout, reload and retry.",
		);
	} finally {
		await browser?.close();
		await server.close();
		await rm(cacheDir, { recursive: true, force: true });
	}
}
