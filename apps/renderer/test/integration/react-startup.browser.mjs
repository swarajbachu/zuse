import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite-plus";

// Run with `bun run test:startup-browser`. This deliberately withholds HMR's
// automatic reload: a slow/retrying document must not receive a second React
// instance while its original React DOM root is still mounted.
const cacheDir = await mkdtemp(join(tmpdir(), "zuse-react-probe-"));
const root = resolve(import.meta.dirname, "../..");
const errors = [];
const server = await createServer({
	root,
	configFile: resolve(root, "vite.config.ts"),
	cacheDir,
	server: {
		host: "127.0.0.1",
		port: 15800,
		strictPort: false,
		open: false,
		hmr: false,
	},
	plugins: [
		{
			name: "startup-probe",
			configResolved(config) {
				// Emulate imports that source scanning cannot discover ahead of time.
				config.optimizeDeps.entries = [];
			},
			configureServer(server) {
				server.middlewares.use("/__probe", async (_req, res) => {
					res.setHeader("Content-Type", "text/html");
					res.end(
						await server.transformIndexHtml(
							"/__probe.html",
							'<div id="root"></div><script type="module" src="/@id/__x00__startup-probe"></script>',
						),
					);
				});
			},
			resolveId(id) {
				if (id.startsWith("\0") && id.split("?")[0].endsWith("probe"))
					return id;
			},
			load(id) {
				id = id.split("?")[0];
				if (id === "\0motion-probe") return `import 'motion/react';`;
				if (id === "\0chart-probe")
					return `import 'd3-scale'; import 'd3-shape';`;
				if (id === "\0late-probe")
					return `
      import '@base-ui/react/dialog';
      import '@base-ui/react/alert-dialog';
      import '@base-ui/react/input';
      import '@base-ui/react/scroll-area';
      import 'gradient-shimmer';
      import 'lucide-react';
      import 'posthog-js/dist/module.slim';
      export {useDefaultLayout} from 'react-resizable-panels';`;
				if (id === "\0startup-probe")
					return `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    const root = createRoot(document.getElementById('root'));
    root.render(React.createElement('p', null, 'boot'));
    setTimeout(() => {const url = '/@id/__x00__motion-probe'; import(/* @vite-ignore */ url);}, 1800);
    setTimeout(() => {const url = '/@id/__x00__chart-probe'; import(/* @vite-ignore */ url);}, 2200);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const lateUrl = '/@id/__x00__late-probe';
    const { useDefaultLayout } = await import(/* @vite-ignore */ lateUrl).catch(async () => {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const retryUrl = lateUrl + '?retry=1';
      return import(/* @vite-ignore */ retryUrl);
    });
    function Probe() {
      useDefaultLayout({id: 'probe', panelIds: ['left', 'right']});
      return React.createElement('p', null, 'layout ready');
    }
    root.render(React.createElement(Probe));
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
		...(process.env.PLAYWRIGHT_CHANNEL
			? { channel: process.env.PLAYWRIGHT_CHANNEL }
			: {}),
	});
	const page = await browser.newPage();
	page.on("pageerror", (error) => errors.push(error.message));
	for (const mode of ["cold", "warm", "forced-restart"]) {
		if (mode === "forced-restart") await server.restart(true);
		const address = server.httpServer.address();
		await page.goto(`http://127.0.0.1:${address.port}/__probe`);
		await page
			.getByText("layout ready", { exact: true })
			.waitFor({ timeout: 15000 });
		// Let both later import batches finish; checking first paint alone misses
		// the invalidation that caused the next screen to crash.
		await page.waitForTimeout(3000);
		await page
			.getByText("layout ready", { exact: true })
			.waitFor({ timeout: 10000 });
		if (errors.length) throw new Error(errors.join("\n"));
		console.log(`PASS: ${mode} React panel startup`);
	}
} finally {
	console.log(JSON.stringify({ errors }));
	await browser?.close();
	await server.close();
	await rm(cacheDir, { recursive: true, force: true });
}
