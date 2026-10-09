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
				if (
					importer?.includes("use-cloud-onboarding.ts") &&
					id.endsWith("cloud-workspace-session-cache.ts")
				)
					return "\0cloud-setup-cache";
				if (
					importer?.includes("use-cloud-onboarding.ts") &&
					id.endsWith("control-plane-client.ts")
				)
					return "\0cloud-setup-client";
			},
			load(id) {
				if (id === "\0cloud-setup-cache")
					return `
    export const loadCloudEntitlements = () => new Promise((_resolve, reject) => { window.failStatus = () => reject(new Error('offline')); });
    export const loadCloudProviders = () => Promise.reject(new Error('offline'));
    export const hasCloudEntitlement = () => true;
    export const loadCloudWorkspacePlacement = () => new Promise(() => {});
   `;
				if (id === "\0cloud-setup-client")
					return `export const subscribeControlPlaneSessionCache = () => () => {};`;
				if (id === "\0cloud-setup-probe")
					return `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {useCloudOnboarding} from '/src/hooks/use-cloud-onboarding.ts';
    import {requestCloudOnboarding} from '/src/lib/cloud-onboarding.ts';
    import {CloudImageProviders} from '/src/components/settings/cloud-image-providers.tsx';
    function Probe() {
     const onboarding = useCloudOnboarding('test-account', true);
     return React.createElement(React.Fragment, null,
      React.createElement('button', {onClick: requestCloudOnboarding}, 'Open setup guide'),
      React.createElement('p', {role: 'status'}, onboarding.open ? 'Guide open' : 'Guide closed'),
      React.createElement(CloudImageProviders, {providers: [{providerId:'boxd',displayName:'boxd'}], images:[{providerId:'boxd',state:'ready',updatedAt:1,repositories:[],providers:[],builds:[{buildId:'build',state:'ready',mode:'rebuild',active:true,runtimeVersion:'v1',configurationDigest:'config',repositories:[],providers:[],createdAt:1,updatedAt:2,logText:'Build completed successfully'}]}]})
     );
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
	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(
		`http://127.0.0.1:${server.httpServer.address().port}/__cloud_setup`,
	);
	await page
		.getByRole("button", { name: "Open setup guide" })
		.waitFor({ timeout: 30000 });
	await page.waitForFunction(() => typeof window.failStatus === "function");
	await page.getByRole("button", { name: "Open setup guide" }).click();
	await page
		.getByText("Guide open", { exact: true })
		.waitFor({ timeout: 1000 });
	await page.evaluate(() => window.failStatus());
	assert.equal(await page.getByRole("status").textContent(), "Guide open");
	assert.equal(await page.getByText("Build completed successfully").count(), 0);
	await page.getByRole("button", { name: /boxd/ }).click();
	await page.getByRole("dialog").waitFor();
	await page.getByText("Build completed successfully").waitFor();
	await page.keyboard.press("Escape");
	await page.getByRole("dialog").waitFor({ state: "hidden" });
	assert.deepEqual(errors, []);
	console.log(
		"PASS: onboarding opens while status stalls, survives failed requests, and provider details open in a dialog",
	);
} finally {
	await browser?.close();
	await server.close();
	await rm(cacheDir, { recursive: true, force: true });
}
