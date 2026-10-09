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
							'<html class="dark"><body><div id="root" style="max-width:600px;margin:32px auto"></div><script type="module" src="/@id/__x00__snapshot-auth-probe"></script>',
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
     if(name === 'cloud.snapshot.import') {if(window.failImport) throw new Error('Import failed'); if(window.pauseImport) await new Promise(resolve => {window.resolveImport = resolve;}); window.image = {...window.image, snapshot: {...window.image.snapshot, agentAuthentication: payload.agentAuthentication}}; return window.image;}
     if(name === 'cloud.auth.login.start') return {operationId:'login', providerId:'codex', state:'authorizing', userCode:'TEST-CODE', verificationUri:'https://example.test/login'};
     if(name === 'cloud.auth.login.poll') { window.auth.providers = [{providerId:'codex',state:'connected',method:'subscription',accountLabel:'dev@example.test'}]; return {operationId:'login',providerId:'codex',state:'connected'}; }
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
    window.image = {providerId:'boxd',state:'ready',snapshot:{snapshotId:'snap-original',runtimeUser:'developer',agentAuthentication:'native',gitAuthentication:'native',agents:[{providerId:'claude',state:'detected',account:'snapshot@example.test'},{providerId:'codex',state:'detected',account:'ChatGPT'}],repositories:[{path:'/home/developer/My Projects/repo'}]}};
    window.connections = {customSnapshotsEnabled:true,connections:[{connectionId:'byok',providerId:'boxd',active:true}]};
    window.auth = {authorityState:'ready',providers:[]};
    function App(){const [image,setImage] = React.useState(window.image);return React.createElement(CloudSnapshotAuthSetup,{image,onChanged:async()=>{window.saved++;setImage({...window.image});}})}
    createRoot(document.getElementById('root')).render(React.createElement(App));`;
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
	const page = await browser.newPage({
		viewport: { width: 1000, height: 560 },
	});
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	for (const query of ["", "?cold"]) {
		await page.goto(
			`http://127.0.0.1:${server.httpServer.address().port}/__snapshot_auth${query}`,
		);
		const source = page.getByRole("combobox", {
			name: "Sign in with",
			exact: true,
		});
		const choose = async (name) => {
			await source.click();
			await page.getByRole("option", { name, exact: true }).click();
		};
		const apply = page.getByRole("button", { name: "Switch", exact: true });
		const cancel = page.getByRole("button", { name: "Cancel", exact: true });
		await source.waitFor();
		await page.waitForFunction(
			() =>
				document
					.querySelector('[role="combobox"]')
					?.hasAttribute("data-disabled") === false,
		);
		assert.equal(await page.getByRole("dialog").count(), 0);
		assert.equal(await source.textContent(), "Snapshot logins");
		assert.equal(
			await page.getByText("Login detected", { exact: true }).count(),
			2,
		);
		assert.equal(await page.getByText("Connected", { exact: true }).count(), 0);
		assert.equal(await apply.count(), 0);
		assert.equal(await page.getByRole("textbox").count(), 0);
		await page.screenshot({
			path: resolve(root, "../../.context/snapshot-auth-primary.png"),
			fullPage: true,
		});
		// Source choice is inline. Cancelling a draft never changes the snapshot.
		await source.focus();
		await source.press("Enter");
		await page
			.getByRole("option", { name: "Zuse accounts", exact: true })
			.click();
		assert.equal(await page.getByRole("dialog").count(), 0);
		assert.equal(await apply.isDisabled(), true);
		await page
			.getByText("Connect at least one agent above to switch.", { exact: true })
			.waitFor();
		await page
			.getByText("Switch new workspaces to Zuse accounts?", { exact: true })
			.waitFor();
		await cancel.click();
		assert.equal(await apply.count(), 0);
		assert.deepEqual(await page.evaluate(() => window.calls), []);
		await choose("Zuse accounts");
		await page
			.getByRole("button", { name: "Connect", exact: true })
			.nth(1)
			.click();
		const codex = page.getByRole("dialog", {
			name: "Set up Codex",
			exact: true,
		});
		await codex
			.getByRole("button", { name: "Start device login", exact: true })
			.click();
		await page.waitForFunction(() =>
			window.calls.some((c) => c.name === "cloud.auth.login.poll"),
		);
		await page.keyboard.press("Escape");
		await codex.waitFor({ state: "hidden" });
		await page.getByText("dev@example.test", { exact: true }).waitFor();
		await page.getByRole("button", { name: "Manage", exact: true }).click();
		await page
			.getByRole("menuitem", { name: "Reauthorize", exact: true })
			.click();
		await codex.waitFor();
		await page.keyboard.press("Escape");
		await codex.waitFor({ state: "hidden" });
		await page.getByText("Agent sign-in", { exact: true }).click();
		await page.screenshot({
			path: resolve(root, "../../.context/snapshot-auth-alternative.png"),
			fullPage: true,
		});
		await page.setViewportSize({ width: 420, height: 640 });
		await page.screenshot({
			path: resolve(
				root,
				"../../.context/snapshot-auth-alternative-narrow.png",
			),
			fullPage: true,
		});
		assert.equal(
			await page.evaluate(
				() => document.documentElement.scrollWidth > window.innerWidth,
			),
			false,
		);
		await page.setViewportSize({ width: 1000, height: 560 });
		await page.evaluate(() => {
			window.pauseImport = true;
		});
		await apply.click();
		await page.waitForFunction(
			() => typeof window.resolveImport === "function",
		);
		assert.equal(await source.getAttribute("data-disabled"), "");
		assert.equal(await cancel.isDisabled(), true);
		assert.equal(await page.evaluate(() => window.saved), 0);
		await page.evaluate(() => {
			window.pauseImport = false;
			window.resolveImport();
		});
		await page.waitForFunction(() => window.saved === 1);
		await page
			.getByText(
				"Saved for new workspaces. Existing workspaces keep their current logins.",
				{ exact: true },
			)
			.waitFor();
		assert.equal(await apply.count(), 0);
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
		await choose("Snapshot logins");
		assert.equal(
			await page.getByText("Login detected", { exact: true }).count(),
			2,
		);
		assert.equal(await page.getByText("Connected", { exact: true }).count(), 0);
		await page
			.getByText("Switch new workspaces back to snapshot logins?", {
				exact: true,
			})
			.waitFor();
		await page.evaluate(() => {
			window.failImport = true;
		});
		await apply.click();
		await page.getByRole("alert").waitFor();
		assert.equal(await page.evaluate(() => window.saved), 1);
		await page.evaluate(() => {
			window.failImport = false;
		});
		await apply.click();
		await page.waitForFunction(() => window.saved === 2);
		const restored = await page.evaluate(
			() =>
				window.calls.filter((c) => c.name === "cloud.snapshot.import").at(-1)
					.payload,
		);
		assert.equal(restored.agentAuthentication, "native");
		assert.equal(restored.gitAuthentication, "native");
		assert.equal(restored.snapshotId, "snap-original");
		await page
			.getByText(
				"Saved for new workspaces. Existing workspaces keep their current logins.",
				{ exact: true },
			)
			.waitFor();
		assert.equal(await apply.count(), 0);
		assert.equal(await source.getAttribute("data-disabled"), null);
	}
	assert.deepEqual(errors, []);
	console.log(
		"Snapshot-first authentication: inline switching, cancellation, provider login, apply/retry and narrow layout passed with cached and uncached snapshots",
	);
} finally {
	await browser?.close();
	await server.close();
	await rm(cacheDir, { recursive: true, force: true });
}
