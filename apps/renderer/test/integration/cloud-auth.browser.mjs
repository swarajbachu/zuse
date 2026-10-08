import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite-plus";

const root = resolve(import.meta.dirname, "../..");
const cacheDir = await mkdtemp(resolve(root, ".cloud-auth-probe-"));
const server = await createServer({
	root,
	configFile: resolve(root, "vite.config.ts"),
	cacheDir,
	server: {
		host: "127.0.0.1",
		port: 15823,
		strictPort: false,
		open: false,
		hmr: false,
		watch: null,
	},
	plugins: [
		{
			name: "cloud-auth-probe",
			enforce: "pre",
			configureServer(server) {
				server.middlewares.use("/__cloud_auth", async (_req, res) => {
					res.setHeader("Content-Type", "text/html");
					res.end(
						await server.transformIndexHtml(
							"/__cloud_auth.html",
							'<div id="root"></div><script type="module" src="/@id/__x00__cloud-auth-probe"></script>',
						),
					);
				});
			},
			resolveId(id, importer) {
				if (id === "\0cloud-auth-probe") return id;
				if (!importer?.includes("cloud-workspace-auth.tsx")) return;
				if (id.endsWith("cloud-workspace-session-cache.ts"))
					return "\0cloud-auth-cache";
				if (id.endsWith("control-plane-client.ts"))
					return "\0cloud-auth-client";
				if (id.endsWith("cloud-image-monitor.ts")) return "\0cloud-auth-images";
			},
			load(id) {
				if (id === "\0cloud-auth-images")
					return `export const refreshCloudImages = async () => {};`;
				if (id === "\0cloud-auth-cache")
					return `
					export const peekCloudAuth = () => undefined;
					export const loadCloudAuth = () => new Promise(() => {});
				`;
				if (id === "\0cloud-auth-client")
					return `
					window.authCalls = [];
					export const subscribeControlPlaneSessionCache = () => () => {};
					export const runCloudControl = (run) => run(new Proxy({}, {get: (_, method) => () => {
						window.authCalls.push(method);
						if (window.authReplies?.[method]) return Promise.resolve(window.authReplies[method]);
						return new Promise((resolve, reject) => { window.rejectAuth = () => reject(new Error('offline')); });
					}}));
				`;
				if (id === "\0cloud-auth-probe")
					return `
					import '/src/styles.css';
					import React from 'react';
					import {createRoot} from 'react-dom/client';
					import {CloudWorkspaceAuth} from '/src/components/settings/cloud-workspace-auth.tsx';
					createRoot(document.getElementById('root')).render(React.createElement(CloudWorkspaceAuth));
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
		...(process.env.CHROME_PATH
			? { executablePath: process.env.CHROME_PATH }
			: {}),
		args: ["--no-sandbox"],
	});
	const page = await browser.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(
		`http://127.0.0.1:${server.httpServer.address().port}/__cloud_auth`,
	);
	const connect = page.getByRole("button", { name: "Connect", exact: true });
	await connect.first().waitFor({ timeout: 30000 });
	assert.equal(await connect.nth(1).isEnabled(), true);
	await connect.nth(1).click();
	const dialog = page.getByRole("dialog");
	await dialog.waitFor({ timeout: 1000 });
	assert.deepEqual(await page.evaluate(() => window.authCalls), []);
	const login = dialog.getByRole("button", { name: "Start device login" });
	await login.click();
	assert.deepEqual(await page.evaluate(() => window.authCalls), [
		"cloud.auth.login.start",
	]);
	const pendingLogin = dialog.getByRole("button", {
		name: "Requesting code…",
		exact: true,
	});
	assert.equal(await pendingLogin.isEnabled(), false);
	assert.equal(await pendingLogin.getAttribute("aria-busy"), "true");
	assert.match(
		await dialog.getByRole("status").innerText(),
		/Requesting a one-time code/,
	);
	await page.evaluate(() => window.rejectAuth());
	await dialog.getByRole("alert").waitFor();
	assert.equal(await login.isEnabled(), true);
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await dialog.waitFor({ state: "hidden" });
	await connect.nth(2).click();
	await dialog.waitFor({ timeout: 1000 });
	await dialog.getByLabel("API key", { exact: true }).fill("test-key-123456");
	await dialog
		.getByRole("button", { name: "Save and verify", exact: false })
		.click();
	assert.deepEqual(await page.evaluate(() => window.authCalls), [
		"cloud.auth.login.start",
		"cloud.auth.provision",
	]);
	await page.evaluate(() => window.rejectAuth());
	await dialog.getByRole("alert").waitFor();
	// A resolved RPC containing a failed verification must not close the dialog.
	await page.evaluate(async () => {
		const key = await crypto.subtle.generateKey(
			{
				name: "RSA-OAEP",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["encrypt", "decrypt"],
		);
		window.authReplies = {
			"cloud.auth.provision": {
				providers: [],
				encryptionKeyId: "test",
				encryptionPublicJwk: JSON.stringify(
					await crypto.subtle.exportKey("jwk", key.publicKey),
				),
			},
			"cloud.auth.configure": {
				providerId: "claude",
				state: "expired",
				errorCode: "authentication-required",
			},
		};
	});
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await dialog.waitFor({ state: "hidden" });
	await connect.first().click();
	await dialog
		.getByLabel("Setup token", { exact: true })
		.fill("sk-ant-oat01-example");
	await dialog
		.getByRole("button", { name: "Save and verify", exact: false })
		.click();
	await dialog.getByRole("alert").waitFor();
	assert.equal(await dialog.isVisible(), true);
	assert.ok(
		(await page.evaluate(() => window.authCalls)).includes(
			"cloud.auth.configure",
		),
	);
	assert.equal(
		await dialog.getByLabel("Setup token", { exact: true }).inputValue(),
		"sk-ant-oat01-example",
	);
	assert.match(
		await dialog.getByRole("alert").innerText(),
		/verification failed/,
	);
	await page.evaluate(() => {
		window.authReplies["cloud.auth.configure"] = {
			providerId: "claude",
			state: "connected",
		};
	});
	await dialog
		.getByRole("button", { name: "Save and verify", exact: false })
		.click();
	await dialog.waitFor({ state: "hidden" });

	assert.deepEqual(errors, []);
	console.log(
		"PASS: Connect opens during stalled status; device login starts directly, shows failures and allows retry; API keys provision on save.",
	);
} finally {
	await browser?.close();
	await server.close();
	await rm(cacheDir, { recursive: true, force: true });
}
