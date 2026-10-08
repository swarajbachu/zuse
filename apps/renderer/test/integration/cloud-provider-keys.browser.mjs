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
					if (id.endsWith("cloud-workspace-session-cache.ts"))
						return "\0provider-cache";
				}
			},
			load(id) {
				if (id === "\0provider-client")
					return `
                    export const runCloudControl = () => Promise.resolve(window.saveResult);
                    export const subscribeControlPlaneSessionCache = listener => { window.cacheListener = listener; return () => { window.cacheListener = null; }; };
                `;
				if (id === "\0provider-cache")
					return `
                    export const peekCloudProviderConnections = () => window.cachedConnections;
                    export const cacheCloudProviderConnections = async value => { window.cachedConnections = value; window.cacheListener?.('cloud-workspace:connections'); };
                    export const loadCloudProviderConnections = () => new Promise((resolve, reject) => window.requests.push({resolve, reject}));
                `;
				if (id === "\0cloud-setup-probe")
					return `
                    import React from 'react';
                    import {createRoot} from 'react-dom/client';
                    import {CloudProviderConnectForm, useCloudProviderConnections} from '/src/components/settings/cloud-provider-keys.tsx';
                    window.requests = [];
                    function Probe() {
                        const keys = useCloudProviderConnections();
                        window.keys = keys;
                        return React.createElement(React.Fragment, null, React.createElement('pre', {id:'state'}, JSON.stringify({active:keys.active.length, enabled:keys.customSnapshotsEnabled, loading:keys.loading, error:keys.loadError})), React.createElement(CloudProviderConnectForm, {keys, providerId:'boxd', onChanged: () => new Promise((resolve,reject) => { window.refreshAfterSave = {resolve,reject}; })}));
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
		executablePath: process.env.CHROME_BIN,
	});
	const page = await browser.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(
		`http://127.0.0.1:${server.httpServer.address().port}/__cloud_setup`,
	);
	await page.waitForFunction(() => window.requests.length === 1);
	const connected = {
		connections: [
			{ connectionId: "test", providerId: "boxd", active: true, createdAt: 1 },
		],
		customSnapshotsEnabled: true,
	};
	const disconnected = { connections: [], customSnapshotsEnabled: false };
	const state = () => page.locator("#state").textContent().then(JSON.parse);
	const flush = () =>
		page.evaluate(
			() =>
				new Promise((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(resolve)),
				),
		);
	await page.evaluate(
		(value) => window.requests.shift().resolve(value),
		connected,
	);
	await flush();
	assert.deepEqual(await state(), {
		active: 1,
		enabled: true,
		loading: false,
		error: false,
	});

	// A disconnect wins over an older successful refresh.
	await page.evaluate((value) => {
		window.keys.reload();
		window.keys.apply(value);
	}, disconnected);
	await page.evaluate(
		(value) => window.requests.shift().resolve(value),
		connected,
	);
	await flush();
	assert.deepEqual(await state(), {
		active: 0,
		enabled: false,
		loading: false,
		error: false,
	});

	// New cache data also invalidates an older request's error.
	await page.evaluate((value) => {
		window.keys.reload();
		window.cachedConnections = value;
		window.cacheListener("cloud-workspace:connections");
		window.requests.shift().reject(new Error("old request failed"));
	}, connected);
	await flush();
	assert.deepEqual(await state(), {
		active: 1,
		enabled: true,
		loading: false,
		error: false,
	});

	// Focus refreshes remain supported; newest reload wins if responses reorder.
	await page.evaluate(() => {
		window.dispatchEvent(new Event("focus"));
		window.keys.reload();
	});
	await page.evaluate(
		(value) => window.requests.pop().resolve(value),
		disconnected,
	);
	await page.evaluate(
		(value) => window.requests.shift().resolve(value),
		connected,
	);
	await flush();
	assert.deepEqual(await state(), {
		active: 0,
		enabled: false,
		loading: false,
		error: false,
	});

	// Current failures still show retry state rather than getting swallowed.
	await page.evaluate(() => {
		window.keys.reload();
		window.requests.shift().reject(new Error("current failure"));
	});
	await flush();
	assert.deepEqual(await state(), {
		active: 0,
		enabled: false,
		loading: false,
		error: true,
	});
	// A successful save releases the form even while unrelated settings refresh.
	await page.evaluate((value) => {
		window.saveResult = value;
	}, connected);
	const keyInput = page.getByPlaceholder("boxd API key");
	await keyInput.fill("test-key");
	await page.getByRole("button", { name: "Connect", exact: true }).click();
	await page.waitForFunction(() => window.refreshAfterSave !== undefined);
	await flush();
	assert.equal(
		await keyInput.isEnabled(),
		true,
		"Saved key must not wait for settings refresh",
	);
	await page.evaluate(() =>
		window.refreshAfterSave.reject(new Error("refresh offline")),
	);
	await flush();
	assert.equal(await page.getByText(/didn't accept this key/).count(), 0);
	assert.equal(await keyInput.inputValue(), "");
	assert.equal((await state()).active, 1);
	assert.deepEqual(errors, []);
	console.log("Provider connection refresh races: passed");
} finally {
	await browser?.close();
	await server.close();
	await rm(cacheDir, { recursive: true, force: true });
}
