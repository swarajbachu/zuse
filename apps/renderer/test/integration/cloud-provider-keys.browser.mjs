import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite-plus";

const root = resolve(import.meta.dirname, "../..");
const cacheDir = await mkdtemp(resolve(root, ".cloud-setup-probe-"));
const server = await createServer({
	root,
	configFile: resolve(root, "vite.config.ts"),
	cacheDir,
	server: {
		host: "127.0.0.1",
		port: 15820,
		strictPort: false,
		open: false,
		hmr: false,
		watch: null,
	},
	plugins: [
		{
			name: "cloud-setup-probe",
			enforce: "pre",
			configureServer(server) {
				server.middlewares.use("/__cloud_setup", async (_req, res) => {
					res.setHeader("Content-Type", "text/html");
					res.end(
						await server.transformIndexHtml(
							"/__cloud_setup.html",
							'<div id="root"></div><script type="module" src="/@id/__x00__cloud-setup-probe"></script>',
						),
					);
				});
			},
			resolveId(id, importer) {
				if (id === "\0cloud-setup-probe") return id;
				if (importer?.includes("cloud-provider-keys.tsx")) {
					if (id.endsWith("control-plane-client.ts"))
						return "\0provider-client";
					if (id.endsWith("cloud-snapshot-settings.tsx"))
						return "\0snapshot-panel";
				}
			},
			load(id) {
				if (id === "\0provider-client")
					return `export const runCloudControl = fn => fn({'cloud.providerConnections.list': async () => ({customSnapshotsEnabled: window.snapshotEnabled, connections: [{connectionId:'test',providerId:'boxd',active:true,createdAt:1}]})});`;
				if (id === "\0snapshot-panel")
					return `import React from 'react'; export const CloudSnapshotSettings = () => React.createElement('div', {'data-testid':'snapshot-panel'}, 'Custom snapshot');`;
				if (id === "\0cloud-setup-probe")
					return `
                    import React from 'react';
                    import {createRoot} from 'react-dom/client';
                    import {CloudProviderKeys} from '/src/components/settings/cloud-provider-keys.tsx';
                    window.snapshotEnabled = false;
                    createRoot(document.getElementById('root')).render(React.createElement(CloudProviderKeys, {onChanged:async()=>{}}));
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
		executablePath: process.env.CHROME_BIN,
	});
	const page = await browser.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(
		`http://127.0.0.1:${server.httpServer.address().port}/__cloud_setup`,
	);
	await page
		.getByText("Connected", { exact: true })
		.waitFor({ timeout: 30000 });
	assert.equal(await page.getByTestId("snapshot-panel").count(), 0);
	await page.evaluate(() => {
		window.snapshotEnabled = true;
		window.dispatchEvent(new Event("focus"));
	});
	await page.getByTestId("snapshot-panel").waitFor({ timeout: 3000 });
	await page.evaluate(() => {
		window.snapshotEnabled = false;
		window.dispatchEvent(new Event("focus"));
	});
	await page
		.getByTestId("snapshot-panel")
		.waitFor({ state: "detached", timeout: 3000 });
	assert.deepEqual(errors, []);
	console.log("Provider settings refresh snapshot capability on focus: passed");
} finally {
	await browser?.close();
	await server.close();
	await rm(cacheDir, { recursive: true, force: true });
}
