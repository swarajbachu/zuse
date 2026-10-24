import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { createServer } from "vite-plus";

const root = resolve(import.meta.dirname, "../..");
const cacheDir = await mkdtemp(resolve(root, ".usage-profile-probe-"));
const server = await createServer({
	root,
	configFile: false,
	cacheDir,
	resolve: {
		alias: { "~": resolve(root, "src") },
		dedupe: ["react", "react-dom"],
	},
	optimizeDeps: {
		noDiscovery: true,
		include: [
			"react",
			"react-dom/client",
			"react-i18next",
			"i18next",
			"@base-ui/react/dialog",
			"@base-ui/react/input",
			"effect",
		],
	},
	server: {
		host: "127.0.0.1",
		port: 15831,
		strictPort: false,
		open: false,
		hmr: false,
		watch: null,
	},
	plugins: [
		react(),
		tailwindcss(),
		{
			name: "usage-profile-probe",
			enforce: "pre",
			configureServer(server) {
				server.middlewares.use("/__usage_profile", async (_req, res) => {
					res.setHeader("Content-Type", "text/html");
					res.end(
						await server.transformIndexHtml(
							"/__usage_profile.html",
							'<div id="root"></div><script type="module" src="/@id/__x00__usage-profile-probe"></script>',
						),
					);
				});
			},
			resolveId(id, importer) {
				if (id === "\0usage-profile-probe") return id;
				if (!importer?.includes("publish-usage-profile.tsx")) return;
				if (id.endsWith("control-plane-client"))
					return "\0usage-profile-control";
				if (id.endsWith("usage-profile-client"))
					return "\0usage-profile-snapshot";
			},
			load(id) {
				if (id === "\0usage-profile-control")
					return `
    import {Effect} from 'effect';
    window.profileCalls = [];
    window.profileState = {profile:null, published:false};
    export const runCloudControl = (run) => Effect.runPromise(run(new Proxy({}, {get: (_, method) => (input) => Effect.promise(async () => {
     window.profileCalls.push({method,input});
     if(window.failProfile) throw {code:'conflict'};
     if(method==='usage.profile.publish') {
      if(window.holdProfile) await new Promise(resolve=>window.releaseProfile=resolve);
      window.profileState = {published:true,profile:{...input,publishedAt:1,updatedAt:2}};
     }
     if(method==='usage.profile.unpublish') window.profileState={...window.profileState,published:false};
     return window.profileState;
    })})));
   `;
				if (id === "\0usage-profile-snapshot")
					return `
    export const loadUsageProfileSnapshot = async () => ({year:2026,generatedAt:'2026-10-01T12:00:00.000Z',sessionCount:3,days:[{date:'2026-10-01',tokens:400}],models:[{name:'Model A',tokens:400}],breakdown:{input:100,output:100,cacheRead:100,cacheWrite:50,reasoning:50},sources:[{id:'claude',label:'Claude Code',tokens:400}],months:[{month:10,models:[{name:'Model A',tokens:400}]}],projectCount:2,sessionMinutes:{median:12,longest:90},cost:{usd:3.2,complete:true},hours:Array.from({length:24},(_,hour)=>hour===10?400:0)});
   `;
				if (id === "\0usage-profile-probe")
					return `
    import '/src/styles.css';
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {PublishUsageProfile} from '/src/components/usage/publish-usage-profile.tsx';
    import {observeRendererAccount} from '/src/lib/renderer-account.ts';
    window.switchProfileAccount=()=>observeRendererAccount('other-account');
    observeRendererAccount('test-account');
    createRoot(document.getElementById('root')).render(React.createElement(PublishUsageProfile,{environmentId:'local'}));
   `;
			},
		},
	],
});
let browser;
let page;
try {
	await server.listen();
	browser = await chromium.launch({
		headless: true,
		...(process.env.CHROME_PATH
			? { executablePath: process.env.CHROME_PATH }
			: { channel: "chrome" }),
	});
	const context = await browser.newContext();
	const address = server.httpServer.address();
	const origin = `http://127.0.0.1:${address.port}`;
	await context.grantPermissions(["clipboard-read", "clipboard-write"], {
		origin,
	});
	page = await context.newPage();
	page.setDefaultTimeout(20000);
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`${origin}/__usage_profile`);
	await page
		.getByRole("button", { name: "Publish profile", exact: true })
		.click();
	await page
		.getByLabel("Display name", { exact: true })
		.fill("Sample Developer");
	await page
		.getByRole("textbox", { name: "Public handle", exact: true })
		.fill("sample-dev");
	await page
		.getByRole("button", { name: "Publish profile", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Update snapshot", exact: true })
		.waitFor();
	assert.equal(
		await page
			.getByRole("textbox", { name: "Public handle", exact: true })
			.isDisabled(),
		true,
	);
	await page.getByRole("button", { name: "Copy link", exact: true }).click();
	await page.getByRole("button", { name: "Copied", exact: true }).waitFor();
	assert.equal(
		await page.evaluate(() => navigator.clipboard.readText()),
		"https://zuse.sh/u/sample-dev",
	);
	await page.getByRole("switch", { name: /Show estimated cost/u }).click();
	await page
		.getByRole("button", { name: "Update snapshot", exact: true })
		.click();
	await page.waitForFunction(
		() =>
			window.profileCalls.filter(
				(call) => call.method === "usage.profile.publish",
			).length === 2,
	);
	await page.getByRole("button", { name: "Unpublish", exact: true }).click();
	await page
		.getByText("Your profile is unpublished.", { exact: false })
		.waitFor();
	assert.equal(
		await page.getByRole("button", { name: "Copy link", exact: true }).count(),
		0,
	);
	await page.setViewportSize({ width: 390, height: 720 });
	await page.evaluate(() => {
		window.failProfile = true;
	});
	await page
		.getByRole("button", { name: "Publish profile", exact: true })
		.click();
	await page
		.getByText("That handle is unavailable. Choose another handle.", {
			exact: true,
		})
		.waitFor();
	await page.evaluate(() => {
		window.failProfile = false;
		window.holdProfile = true;
	});
	await page
		.getByRole("button", { name: "Publish profile", exact: true })
		.click();
	await page.waitForFunction(() => typeof window.releaseProfile === "function");
	await page.evaluate(() => {
		window.switchProfileAccount();
		window.releaseProfile();
	});
	await page
		.getByRole("button", { name: "Publish profile", exact: true })
		.waitFor();
	assert.equal(
		await page.getByRole("dialog").count(),
		0,
		"account changes close the old profile dialog",
	);
	assert.deepEqual(errors, []);
	const calls = await page.evaluate(() => window.profileCalls);
	const publishes = calls.filter(
		(call) => call.method === "usage.profile.publish",
	);
	const published = publishes[0].input;
	assert.equal(published.cost, null, "cost is hidden by default");
	assert.equal(published.hours, null, "hours are hidden by default");
	assert.deepEqual(publishes[1].input.cost, { usd: 3.2, complete: true });
	assert.equal(publishes[1].input.hours, null);
	assert.deepEqual(
		Object.keys(published).sort(),
		[
			"breakdown",
			"cost",
			"days",
			"displayName",
			"generatedAt",
			"github",
			"handle",
			"hours",
			"models",
			"months",
			"projectCount",
			"sessionCount",
			"sessionMinutes",
			"sources",
			"year",
		].sort(),
	);
	console.log(
		"Usage profile browser flow passed: publish, update, copy, unpublish, conflict, account switch",
	);
} catch (error) {
	console.error(await page?.locator("body").ariaSnapshot());
	await page?.screenshot({
		path: resolve(root, "../../.context/usage-profile-dialog-failure.png"),
		fullPage: true,
	});
	throw error;
} finally {
	await browser?.close();
	await server.close();
	await rm(cacheDir, { recursive: true, force: true });
}
