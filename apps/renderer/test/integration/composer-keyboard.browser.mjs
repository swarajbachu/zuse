import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite-plus";

const root = resolve(import.meta.dirname, "../..");
const cacheDir = await mkdtemp(resolve(root, ".composer-keyboard-probe-"));
const server = await createServer({
	root,
	configFile: resolve(root, "vite.config.ts"),
	cacheDir,
	server: {
		host: "127.0.0.1",
		port: 15869,
		strictPort: false,
		open: false,
		hmr: false,
		watch: null,
	},
	plugins: [
		{
			name: "composer-keyboard-probe",
			enforce: "pre",
			configureServer(server) {
				server.middlewares.use("/__composer", async (_req, res) => {
					res.setHeader("Content-Type", "text/html");
					res.end(
						await server.transformIndexHtml(
							"/__composer.html",
							'<div id="composer"></div><button id="outside">Outside</button><script type="module" src="/@id/__x00__composer-keyboard-probe"></script>',
						),
					);
				});
			},
			resolveId(id) {
				if (id === "\0composer-keyboard-probe") return id;
			},
			load(id) {
				if (id === "\0composer-keyboard-probe")
					return `
   import {createComposerView} from '/src/lib/codemirror/composer.ts';
   window.result = {stops: 0, submissions: []};
   window.view = createComposerView({parent: document.getElementById('composer'), placeholderText: 'Message', callbacks: {
     onChange() {}, onTrigger() {}, onFilesDropped() {}, canInterrupt: () => true,
     onInterrupt: () => {window.result.stops++; return true;},
     onSubmit: mode => {window.result.submissions.push(mode ?? 'default'); return true;}
   }});
   window.view.focus();
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
	const page = await browser.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`http://127.0.0.1:${server.config.server.port}/__composer`);
	const editor = page.getByRole("textbox", { name: "Message composer" });
	await editor.waitFor({ timeout: 120000 });
	await editor.fill("keep my draft");
	await page.keyboard.press("Escape");
	assert.equal(
		await page.evaluate(() => window.result.stops),
		0,
		"one Escape preserves running response",
	);
	await page.keyboard.press("Escape");
	assert.equal(
		await page.evaluate(() => window.result.stops),
		1,
		"two Escapes stop",
	);
	assert.equal(await editor.innerText(), "keep my draft");
	await page.keyboard.down("Escape");
	await page.keyboard.down("Escape");
	await page.keyboard.down("Escape");
	await page.keyboard.up("Escape");
	assert.equal(
		await page.evaluate(() => window.result.stops),
		1,
		"holding Escape cannot stop",
	);
	await page.getByRole("button", { name: "Outside" }).click();
	await editor.click();
	await page.keyboard.press("Escape");
	assert.equal(
		await page.evaluate(() => window.result.stops),
		1,
		"leaving the editor resets the sequence",
	);
	await page.keyboard.press("a");
	await page.keyboard.press("Escape");
	assert.equal(
		await page.evaluate(() => window.result.stops),
		1,
		"typing resets the sequence",
	);
	await page.keyboard.press("Alt+Enter");
	assert.deepEqual(await page.evaluate(() => window.result.submissions), [
		"queue",
	]);
	await editor.fill("keep word");
	await page.keyboard.press("Control+End");
	await page.keyboard.press("Control+Backspace");
	assert.equal(
		(await editor.innerText()).trim(),
		"keep",
		"delete word uses a non-closing shortcut",
	);
	assert.deepEqual(errors, []);
	console.log(
		"Composer keyboard browser checks passed: double Escape, held keys, blur, editing, draft retention, queue shortcut.",
	);
} finally {
	await browser?.close();
	await server.close();
	await rm(cacheDir, { recursive: true, force: true });
}
