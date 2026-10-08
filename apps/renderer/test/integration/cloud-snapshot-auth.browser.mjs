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
		port: 15821,
		strictPort: false,
		open: false,
		hmr: false,
		watch: null,
	},
	plugins: [
		{
			name: "snapshot-auth-probe",
			enforce: "pre",
			configureServer(server) {
				server.middlewares.use("/__snapshot_auth", async (_req, res) => {
					res.setHeader("Content-Type", "text/html");
					res.end(
						await server.transformIndexHtml(
							"/__snapshot_auth.html",
							'<div id="root"></div><script type="module" src="/@id/__x00__snapshot-auth-probe"></script>',
						),
					);
				});
			},
			resolveId(id, importer) {
				if (id === "\0snapshot-auth-probe") return id;
				if (importer?.includes("/components/settings/")) {
					if (id.endsWith("control-plane-client.ts")) return "\0auth-client";
					if (id.endsWith("cloud-workspace-session-cache.ts"))
						return "\0auth-cache";
					if (id.endsWith("cloud-image-monitor.ts")) return "\0auth-images";
				}
			},
			load(id) {
				if (id === "\0auth-client")
					return `
    export const subscribeControlPlaneSessionCache = () => () => {};
    export const runCloudControl = fn => fn(new Proxy({}, {get: (_, name) => async payload => {
     window.calls.push({name, payload});
     if(name === 'cloud.snapshot.import') {window.image = {...window.image, snapshot: {...window.image.snapshot, agentAuthentication: payload.agentAuthentication}}; return window.image;}
     if(name === 'cloud.auth.login.start') return {operationId:'login', providerId:'codex', state:'authorizing', userCode:'TEST-CODE', verificationUri:'https://example.test/login'};
     if(name === 'cloud.auth.login.poll') { window.auth.providers = [{providerId:'codex',state:'connected',method:'subscription'}]; return {operationId:'login',providerId:'codex',state:'connected'}; }
     throw new Error('Unexpected operation: '+name);
    }}));`;
				if (id === "\0auth-cache")
					return `
    export const peekCloudImage = () => window.cold ? undefined : window.image;
    export const loadCloudImage = async () => window.image;
    export const peekCloudAuth = () => window.auth;
    export const loadCloudAuth = async () => ({...window.auth});
    export const peekCloudProviderConnections = () => window.connections;
    export const loadCloudProviderConnections = async () => window.connections;
    export const cacheCloudProviderConnections = async () => {};
   `;
				if (id === "\0auth-images")
					return `export const refreshCloudImages = async () => {};`;
				if (id === "\0snapshot-auth-probe")
					return `
    import '/src/styles.css'; import React from 'react'; import {createRoot} from 'react-dom/client';
    import {CloudSnapshotAuthSetup} from '/src/components/settings/cloud-snapshot-auth-setup.tsx';
    window.calls = []; window.saved = 0;
    window.cold = new URLSearchParams(location.search).has('cold');
    window.image = {providerId:'boxd',state:'ready',snapshot:{snapshotId:'snap-original',runtimeUser:'developer',agentAuthentication:'native',gitAuthentication:'native',repositories:[{path:'/home/developer/My Projects/repo'}]}};
    window.connections = {customSnapshotsEnabled:true,connections:[{connectionId:'byok',providerId:'boxd',active:true}]};
    window.auth = {authorityState:'ready',providers:[]};
    createRoot(document.getElementById('root')).render(React.createElement(CloudSnapshotAuthSetup,{onChanged:async()=>{window.saved++}}));`;
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
	page.on("pageerror", (e) => errors.push(e.message));
	for (const query of ["", "?cold"]) {
		await page.goto(
			`http://127.0.0.1:${server.httpServer.address().port}/__snapshot_auth${query}`,
		);
		await page.getByRole("button", { name: "Set up", exact: true }).click();
		await page
			.getByRole("textbox", { name: "Linux user", exact: true })
			.waitFor();
		assert.equal(
			await page
				.getByRole("textbox", { name: "Linux user", exact: true })
				.inputValue(),
			"developer",
		);
		// Opening the editor selects managed auth, but does not save or enroll anything.
		assert.equal(await page.getByRole("switch").first().isChecked(), false);
		assert.deepEqual(await page.evaluate(() => window.calls), []);
		// Use the actual shared Codex dialog and device login, not a separate implementation.
		await page
			.getByRole("button", { name: "Connect", exact: true })
			.nth(1)
			.click();
		await page
			.getByRole("button", { name: "Start device login", exact: true })
			.click();
		await page.waitForFunction(() =>
			window.calls.some((c) => c.name === "cloud.auth.login.poll"),
		);
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: "Save", exact: true }).click();
		await page.waitForFunction(() => window.saved === 1);
		const calls = await page.evaluate(() => window.calls);
		assert.deepEqual(
			calls.find((c) => c.name === "cloud.auth.login.start").payload,
			{ providerId: "codex" },
		);
		const saved = calls.find((c) => c.name === "cloud.snapshot.import").payload;
		assert.equal(saved.agentAuthentication, "zuse");
		assert.equal(saved.gitAuthentication, "native");
		assert.equal(saved.runtimeUser, "developer");
		assert.equal(saved.snapshotId, "snap-original");
		assert.equal(saved.connectionId, "byok");
		assert.deepEqual(saved.repositoryPaths, [
			"/home/developer/My Projects/repo",
		]);
		assert.equal(
			calls.some((c) => c.name.includes("build")),
			false,
		);
	}
	assert.deepEqual(errors, []);
	console.log(
		"Snapshot managed authentication: cached and uncached device login/save passed",
	);
} finally {
	await browser?.close();
	await server.close();
	await rm(cacheDir, { recursive: true, force: true });
}
