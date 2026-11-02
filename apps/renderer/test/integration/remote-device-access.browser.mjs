import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite-plus";

const root = resolve(import.meta.dirname, "../..");
const cacheDir = await mkdtemp(resolve(tmpdir(), "zuse-remote-access-"));
const server = await createServer({
	root,
	configFile: resolve(root, "vite.config.ts"),
	cacheDir,
	server: {
		host: "127.0.0.1",
		port: 15840,
		strictPort: false,
		open: false,
		hmr: false,
		watch: null,
	},
	plugins: [
		{
			name: "remote-device-access-probe",
			enforce: "pre",
			configureServer(server) {
				server.middlewares.use("/__remote_access", async (_req, res) => {
					res.setHeader("Content-Type", "text/html");
					res.end(
						await server.transformIndexHtml(
							"/__remote_access.html",
							'<div id="root"></div><script type="module" src="/@id/__x00__remote-access-probe"></script>',
						),
					);
				});
			},
			resolveId(id, importer) {
				if (importer?.endsWith("settings/devices-pane.tsx")) {
					if (id.endsWith("platform-capabilities.ts"))
						return "\0remote-platform";
					if (
						/\/(connect-link-card|connected-devices-card|using-computers-card|access-confirm-dialogs)\.tsx$/.test(
							id,
						)
					)
						return "\0remote-empty";
				}
				if (id.startsWith("\0remote-")) return id;
				if (id.endsWith("cloud-workspace-catalog.ts"))
					return "\0remote-catalog";
				if (id.endsWith("cloud-ssh-client-bus.ts")) return "\0remote-ssh";
				if (id.endsWith("cloud-sync-client-bus.ts")) return "\0remote-sync";
				if (id.endsWith("machine-resources-client-bus.ts"))
					return "\0remote-resources";
				if (id.endsWith("device-bridge-binding.ts")) return "\0remote-bridge";
				if (id.endsWith("local-device-client-bus.ts")) return "\0remote-local";
				if (id.endsWith("control-plane-client.ts")) return "\0remote-control";
				if (id.endsWith("renderer-account.ts")) return "\0remote-account";
			},
			load(id) {
				if (id === "\0remote-catalog")
					return `export const cloudSyncPreferenceEnabled=()=>false; export const useCloudChatCatalogStore=selector=>selector({summaries:[{workspaceId:"chat",providerId:"boxd",state:"ready",runtimeState:"online",startupPhase:"running",repositoryDisplayName:"zuse",repositoryIdentity:"github.com/zuse",createdAt:0}],syncPrefs:{}});`;
				if (id === "\0remote-ssh")
					return `export const cloudSshSupported=()=>false;export const openCloudWorkspaceSsh=async()=>{};export const prepareCloudWorkspaceSsh=async()=>{};`;
				if (id === "\0remote-sync")
					return `export const cloudSyncSupported=()=>false; export const useCloudSyncStatus=()=>null;export const disableCloudSync=async()=>{};export const enableCloudSync=async()=>{};`;
				if (id === "\0remote-resources")
					return `export const useMachineResources=()=>({data:null});`;
				if (id === "\0remote-platform")
					return `export const rendererPlatformCapabilities=()=>({desktop:false,networkLifecycle:false}); export const openExternal=async()=>{};`;
				if (id === "\0remote-empty")
					return `export const ConnectLinkCard=()=>null; export const ConnectedDevicesCard=()=>null; export const UsingComputersCard=()=>null; export const AccessConfirmDialogs=()=>null;`;
				if (id === "\0remote-account")
					return `export const rendererAccountSnapshot=()=>"account"; export const subscribeRendererAccount=()=>()=>{};`;
				if (id === "\0remote-bridge")
					return `window.localStatus={version:1,enabled:true,connected:true,deviceId:"linux",deviceName:"Linux",commands:[],grants:[],homeDirectory:"/home/test"}; export const localDeviceBridge=async()=>({...window.localStatus});`;
				if (id === "\0remote-local")
					return `export const dispatchLocalDeviceCommand=async(name,input)=>{if(name==="api.status") return {linked:false}; if(name==="pairing.listTokens") return [];window.localStatus.enabled=input.enabled;window.localStatus.connected=input.enabled;window.localChanges.push({name,input});};`;
				if (id === "\0remote-control")
					return `export const runControlPlane=()=>{}; export const runCloudControl=fn=>fn({"deviceBridge.devices":async()=>[{deviceId:"mac",label:"MacBook Pro",connected:false,revoked:false,lastSeen:1},{deviceId:"linux",label:"Linux",connected:true,revoked:false,lastSeen:1}],"deviceBridge.cloud":async(input)=>{if(input.targetDeviceId) window.selected=input.targetDeviceId;return {...window.localStatus,deviceId:window.selected};}});`;
				if (id === "\0remote-access-probe")
					return `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {CloudDeviceAccessCard} from '/src/components/settings/cloud-device-access-card.tsx';
    import {CloudWorkspaceMenu} from '/src/components/cloud-workspace-info.tsx';
    import {AccessMethodsCard} from '/src/components/settings/remote-access/access-methods-card.tsx';
    import {DevicesPane} from '/src/components/settings/devices-pane.tsx';
    import '/src/styles.css';
    window.localChanges=[];window.selected="mac";
    document.documentElement.classList.add('dark');
    const root=createRoot(document.getElementById('root'));
    window.showDevicesPane=key=>root.render(React.createElement(DevicesPane,{key}));
    root.render(React.createElement('div',{style:{maxWidth:640,margin:'40px auto',padding:16,display:'grid',gap:16}},
     React.createElement(CloudWorkspaceMenu,{workspaceId:"chat"}),
     React.createElement(CloudDeviceAccessCard),
     React.createElement(AccessMethodsCard,{status:null,tailnet:null,network:null,networkEnabled:false,canManageNetwork:true,busy:false,tailnetBusy:false,unavailableMethods:['account'],onOpenAccessDialog:()=>{},onRequestNetworkMode:()=>{}})
    ));`;
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
	});
	const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(
		`http://127.0.0.1:${server.httpServer.address().port}/__remote_access`,
	);
	await page.getByText("Connected to your account", { exact: true }).waitFor();
	const selector = page.getByLabel("Computer access (optional)", {
		exact: true,
	});
	assert.equal(await selector.count(), 0);
	await page
		.getByRole("button", { name: "Workspace details", exact: true })
		.click();
	await selector.waitFor({ timeout: 3000 });
	assert.equal(await selector.inputValue(), "mac");
	assert.equal(
		await selector.locator('option[value="mac"]').textContent(),
		"MacBook Pro · Not connected",
	);
	await selector.selectOption("linux");
	await page.waitForFunction(() => window.selected === "linux");
	await page.keyboard.press("Escape");
	await page
		.getByRole("button", { name: "Workspace details", exact: true })
		.click();
	await selector.waitFor();
	assert.equal(await selector.inputValue(), "linux");
	await page.screenshot({
		path: resolve(root, "../../.context/cloud-device-menu.png"),
	});
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Turn off", exact: true }).click();
	await page.getByRole("button", { name: "Enable", exact: true }).waitFor();
	assert.equal(await page.evaluate(() => window.localChanges.length), 1);
	await page.getByText("Couldn’t check Zuse Serve", { exact: true }).waitFor();
	const buttonHeights = await page
		.getByRole("button")
		.evaluateAll((buttons) =>
			buttons.map((button) => button.getBoundingClientRect().height),
		);
	assert.ok(
		buttonHeights.every((height) => height === 28),
		JSON.stringify(buttonHeights),
	);
	await page.screenshot({ path: "/tmp/grookey-remote-access-desktop.png" });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: "/tmp/grookey-remote-access-compact.png" });
	const overflow = await page.evaluate(() => ({
		width: innerWidth,
		scroll: document.documentElement.scrollWidth,
		elements: [...document.querySelectorAll("body *")]
			.filter((e) => e.getBoundingClientRect().right > innerWidth)
			.slice(0, 8)
			.map((e) => ({
				tag: e.tagName,
				cls: e.className,
				text: e.textContent?.slice(0, 80),
				right: e.getBoundingClientRect().right,
			})),
	}));
	assert.equal(
		overflow.scroll > overflow.width,
		false,
		JSON.stringify(overflow),
	);
	await page.screenshot({ path: "/tmp/grookey-remote-access-compact.png" });

	await page.evaluate(() => window.showDevicesPane("no-network"));
	await page
		.getByText("Remote access to this computer", { exact: true })
		.waitFor();
	assert.equal(
		await page
			.getByText("Some connection methods couldn’t be checked.", {
				exact: true,
			})
			.count(),
		0,
	);
	assert.equal(
		await page.getByText("Couldn’t check Tailscale", { exact: true }).count(),
		0,
	);
	await page.evaluate(() => {
		window.zuse = {
			network: {
				getAccessState: async () => null,
				getTailnetShareState: async () => null,
			},
		};
		window.showDevicesPane("null-network");
	});
	await page.getByText("Couldn’t check Tailscale", { exact: true }).waitFor();
	await page
		.getByText("Some connection methods couldn’t be checked.", { exact: true })
		.waitFor();
	assert.deepEqual(errors, []);
	console.log(
		"Remote device access browser checks passed: target selection, independent disable, failed setup status, 28px controls, narrow viewport.",
	);
} finally {
	await browser?.close();
	await server.close();
	await rm(cacheDir, { recursive: true, force: true });
}
