import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite-plus";

const root = resolve(import.meta.dirname, "../..");
const server = await createServer({
	root,
	configFile: resolve(root, "vite.config.ts"),
	server: {
		host: "127.0.0.1",
		port: 15834,
		strictPort: true,
		hmr: false,
		watch: null,
	},
	plugins: [
		{
			name: "plugins-ui-fixture",
			enforce: "pre",
			configureServer(s) {
				s.middlewares.use("/__plugins-settings", async (_req, res) => {
					res.setHeader("Content-Type", "text/html");
					res.end(
						await s.transformIndexHtml(
							"/__plugins-settings.html",
							'<html class="dark"><div id="root"></div><script type="module" src="/@id/__x00__plugins-settings-probe"></script></html>',
						),
					);
				});
				s.middlewares.use("/__plugins", async (_req, res) => {
					res.setHeader("Content-Type", "text/html");
					res.end(
						await s.transformIndexHtml(
							"/__plugins.html",
							'<html class="dark"><div id="root"></div><script type="module" src="/@id/__x00__plugins-probe"></script></html>',
						),
					);
				});
			},
			resolveId(id, importer) {
				if (id === "\0plugins-probe" || id === "\0plugins-settings-probe")
					return id;
				if (
					importer?.includes("mcp-servers-pane.tsx") ||
					importer?.includes("plugins-settings-pane.tsx")
				) {
					if (id.endsWith("store/mcp.ts")) return "\0plugins-mcp";
				}
				if (importer?.includes("skills-settings-list.tsx")) {
					if (id.endsWith("environment-shell-client-bus.ts"))
						return "\0plugins-skills";
				}
				if (
					importer?.includes("plugins-page.tsx") ||
					importer?.includes("plugin-return-handler.tsx") ||
					importer?.includes("connected-plugins.ts") ||
					importer?.includes("plugins-settings-pane.tsx")
				) {
					if (id.endsWith("plugins-client.ts")) return "\0plugins-fixture";
					if (id.endsWith("use-auth.ts")) return "\0plugins-auth";
					if (id.endsWith("platform-capabilities.ts"))
						return "\0plugins-external";
					if (id.endsWith("store/ui.ts")) return "\0plugins-ui";
				}
			},
			load(id) {
				if (id === "\0plugins-mcp")
					return `
const server={key:"claude:github",name:"github",source:"claude-user",kind:"server",parentKey:null,transport:"http",url:"https://api.githubcopilot.com/mcp/",command:null,args:[],enabledInConfig:true,disabledByZuse:false,toggleSupported:true,authenticationAction:null,availableProviders:["claude"]};
const state={servers:[server],statuses:new Map(),refreshing:false,authenticating:new Set(),load:async()=>{},refresh:async()=>{},setEnabled:async()=>{},authenticate:async()=>{}};
export const useMcpStore=(select)=>select(state);
`;
				if (id === "\0plugins-skills")
					return `
const skill=(name,providerId,enabled,toggleSupported)=>({name,providerId,enabled,toggleSupported,scope:"global",description:"Example skill "+name,arguments:[],filePath:"/skills/"+name+"/SKILL.md"});
let skills=[skill("pdf","claude",true,true),skill("deploy","codex",false,true),skill("notes","cursor",true,false)];
export async function dispatchEnvironmentShellCommand(command){
 if(command.kind==="skill.listGlobal")return {result:skills};
 if(command.kind==="skill.setEnabled"){window.lastSkillToggle=command.payload;skills=skills.map(s=>s.name===command.payload.name?{...s,enabled:command.payload.enabled}:s);return {result:{providerId:command.payload.providerId,name:command.payload.name,enabled:command.payload.enabled}};}
 throw new Error("unexpected "+command.kind);
}
`;
				if (id === "\0plugins-settings-probe")
					return `import React from 'react';import{createRoot}from'react-dom/client';import{PluginsSettingsPane}from'/src/components/settings/plugins-settings-pane.tsx';import{ToastProvider}from'/src/components/ui/toast.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(ToastProvider,null,React.createElement('main',{className:'min-h-screen bg-background text-foreground',style:{padding:'36px'}},React.createElement('div',{style:{maxWidth:760,margin:'0 auto'}},React.createElement(PluginsSettingsPane)))));`;
				if (id === "\0plugins-auth")
					return 'export const useAuth=()=>({user:{id:"fixture",email:"user@example.test"},isSignedIn:true});';
				if (id === "\0plugins-ui")
					return "const state={setView(){},setActiveMainTab(){}};export const useUiStore={getState:()=>state};";
				if (id === "\0plugins-external")
					return "export const openExternal=async url=>{window.openedPluginUrl=url;};export const rendererPlatformCapabilities=()=>({desktop:true});";
				if (id === "\0plugins-fixture")
					return `
const entry=(id,name,description,domain,featured=false,category=null)=>({id,name,description,domain,category,featured});
const catalog=[
 entry('linear','Linear','Find and update issues, projects, and documents.','linear.app',true,'productivity'),
 entry('notion','Notion','Search, create, and reorganize workspace content.','notion.com',true,'productivity'),
 entry('sentry','Sentry','Issues, events, releases, and root-cause runs.','sentry.io',true,'observability'),
 entry('cloudflare','Cloudflare Docs','Search Cloudflare documentation from your agents.','cloudflare.com',true),
 ...Array.from({length:60},(_,i)=>entry('tool-'+i,'Tool '+i,'An example MCP server number '+i+'.','example'+i+'.test')),
];
let connections=location.pathname.startsWith('/__plugins-settings')?[{id:'c-linear',pluginId:'linear',label:'Linear',owner:'user',state:'connected',createdAt:1,enabled:true},{id:'c-personal',pluginId:'linear',label:'Personal',owner:'user',state:'connected',createdAt:1,enabled:true}]:[];
import {useCallback,useEffect,useState} from 'react';
const listeners=new Set();
const snapshot=()=>({kind:'snapshot',tenantId:'personal:fixture',tenants:[{id:'personal:fixture',kind:'personal',name:'Personal'}],catalog,connections,endpoint:''});
export const notifyPluginsChanged=()=>{for(const l of listeners)l();};
export function usePluginSnapshot(account){
 const [value,setValue]=useState(null);
 const refresh=useCallback(async()=>{setValue(snapshot());for(const l of listeners)if(l!==refresh)l();},[]);
 useEffect(()=>{if(account===null)return;setValue(snapshot());const l=()=>setValue(snapshot());listeners.add(l);return()=>listeners.delete(l);},[account]);
 return {snapshot:account===null?null:value,failed:false,refresh};
}
export const pluginReturnTo=async()=>({kind:'desktop',port:8976});
export async function pluginRequest(input){
 if(input.action==='setEnabled'){window.lastPluginToggle=input;connections=connections.map(c=>c.id===input.connectionId?{...c,enabled:input.enabled}:c);return {kind:'ok'};}
 if(input.action==='complete'){connections.push({id:'c-linear',pluginId:'linear',label:'Linear',owner:'user',state:'connected',createdAt:Date.now(),enabled:true});return {kind:'attempt',id:'a',connectionId:'c-linear',state:'connected',authorizationUrl:null,expiresAt:Date.now()};}
 if(input.action==='list')return snapshot();
 if(input.action==='disconnect'){connections=connections.filter(c=>c.id!==input.connectionId);return {kind:'ok'};}
 if(input.action==='poll')return {kind:'attempt',id:input.attemptId,connectionId:input.attemptId,state:'pending',authorizationUrl:'https://mcp.notion.com/authorize',expiresAt:Date.now()+60000};
 if(input.action==='cancel'){connections=connections.filter(c=>c.id!==input.attemptId);return {kind:'attempt',id:input.attemptId,connectionId:input.attemptId,state:'cancelled',authorizationUrl:null,expiresAt:Date.now()};}
 if(input.action==='connect'){
  window.lastReturnTo=input.returnTo;
  const id=input.requestId;
  if(input.pluginId==='notion'){connections.push({id,pluginId:'notion',label:'Notion',owner:'user',state:'connecting',createdAt:Date.now()});return {kind:'attempt',id,connectionId:id,state:'pending',authorizationUrl:'https://mcp.notion.com/authorize',expiresAt:Date.now()+60000};}
  connections.push({id,pluginId:input.pluginId,label:input.label,owner:'user',state:'connected',createdAt:Date.now(),enabled:true});return {kind:'attempt',id,connectionId:id,state:'connected',authorizationUrl:null,expiresAt:Date.now()+60000};}
}
`;
				if (id === "\0plugins-probe")
					return `import React from 'react';import{createRoot}from'react-dom/client';import{PluginsPage}from'/src/components/plugins/plugins-page.tsx';import{PluginReturnHandler}from'/src/components/plugin-return-handler.tsx';import{ToastProvider}from'/src/components/ui/toast.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(ToastProvider,null,React.createElement('main',{className:'flex h-screen flex-col bg-background text-foreground'},React.createElement(PluginReturnHandler),React.createElement(PluginsPage))));`;
			},
		},
	],
});
let browser;
try {
	await server.listen();
	browser = await chromium.launch({
		headless: true,
		...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
			? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
			: {}),
	});
	const page = await browser.newPage({
		viewport: { width: 1180, height: 820 },
		deviceScaleFactor: 2,
	});
	const shots = process.env.PLUGINS_SCREENSHOT_DIR;
	const shot = async (name) => {
		if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
	};
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	// A browser return redeems itself: no confirmation dialog.
	await page.goto(
		"http://127.0.0.1:15834/__plugins?plugin_ticket=fixture&plugin_tenant=personal%3Afixture&plugin=Linear",
	);
	await page.getByText("Linear connected", { exact: true }).waitFor();
	assert(!page.url().includes("plugin_ticket"));
	await page
		.getByRole("button", { name: "Manage Linear", exact: true })
		.first()
		.waitFor();
	await page.getByRole("heading", { name: "Featured" }).waitFor();
	await page.getByRole("heading", { name: "All plugins" }).waitFor();
	await shot("plugins-browse");
	await page.getByRole("button", { name: "Show more", exact: true }).click();
	assert.equal(
		await page.getByRole("button", { name: "Show more", exact: true }).count(),
		0,
	);

	// No-auth plugins connect in place.
	await page
		.getByRole("textbox", { name: "Search plugins" })
		.fill("Cloudflare");
	await page.getByRole("heading", { name: "Results" }).waitFor();
	await page
		.getByRole("button", { name: "Connect Cloudflare Docs", exact: true })
		.click();
	await page.getByText("Cloudflare Docs connected", { exact: true }).waitFor();
	await page
		.getByRole("button", { name: "Manage Cloudflare Docs", exact: true })
		.click();
	await page.getByRole("heading", { name: "Information" }).waitFor();
	await shot("plugins-detail-connected");
	await page.getByRole("textbox", { name: "Connection name" }).fill("Personal");
	await page
		.getByRole("button", { name: "Connect another account", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Disconnect", exact: true })
		.nth(1)
		.waitFor();
	assert.match(
		await page
			.getByRole("button", { name: "Disconnect", exact: true })
			.nth(1)
			.locator("..")
			.innerText(),
		/Personal/,
	);
	await shot("plugins-multiple-accounts");
	await page
		.getByRole("button", { name: "Disconnect", exact: true })
		.nth(1)
		.click();
	await page.getByRole("button", { name: "Disconnect", exact: true }).waitFor();
	await page.getByRole("button", { name: "Disconnect", exact: true }).click();
	await page.getByRole("button", { name: "Connect", exact: true }).waitFor();
	await page.getByRole("button", { name: "Plugins", exact: true }).click();
	await page.getByRole("textbox", { name: "Search plugins" }).fill("");

	// OAuth plugins hand off to the browser and show one clear pending state.
	await page
		.getByRole("button", { name: "Connect Notion", exact: true })
		.first()
		.click();
	await page
		.getByText("Finish signing in to Notion in your browser.", {
			exact: false,
		})
		.waitFor();
	assert.equal(
		await page.evaluate(() => window.openedPluginUrl),
		"https://mcp.notion.com/authorize",
	);
	assert.deepEqual(await page.evaluate(() => window.lastReturnTo), {
		kind: "desktop",
		port: 8976,
	});
	await shot("plugins-pending");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await page
		.getByRole("button", { name: "Connect Notion", exact: true })
		.first()
		.waitFor();

	await page.getByRole("tab", { name: "Connected" }).click();
	await page
		.getByRole("button", { name: "Manage Linear", exact: true })
		.waitFor();
	await shot("plugins-connected");
	// Settings → Plugins: manage what agents can use.
	const settings = await browser.newPage({
		viewport: { width: 1000, height: 760 },
		deviceScaleFactor: 2,
	});
	settings.on("pageerror", (error) => errors.push(error.message));
	await settings.goto("http://127.0.0.1:15834/__plugins-settings");
	await settings.getByRole("switch", { name: "Linear", exact: true }).waitFor();
	await settings
		.getByRole("switch", { name: "Linear / Personal", exact: true })
		.waitFor();
	await settings.waitForTimeout(400);
	if (shots)
		await settings.screenshot({ path: `${shots}/settings-plugins.png` });
	await settings.getByRole("switch", { name: "Linear", exact: true }).click();
	await settings.waitForFunction(
		() => window.lastPluginToggle?.enabled === false,
	);
	assert.equal(
		await settings
			.getByRole("switch", { name: "Linear", exact: true })
			.getAttribute("aria-checked"),
		"false",
	);
	assert.equal(
		await settings
			.getByRole("switch", { name: "Linear / Personal", exact: true })
			.getAttribute("aria-checked"),
		"true",
	);
	await settings.getByRole("tab", { name: /MCPs/ }).click();
	await settings.getByText("github", { exact: true }).waitFor();
	if (shots) await settings.screenshot({ path: `${shots}/settings-mcps.png` });
	await settings.getByRole("tab", { name: /Skills/ }).click();
	await settings.getByRole("switch", { name: "deploy" }).waitFor();
	await settings.getByText("Always on", { exact: true }).waitFor();
	await settings.getByRole("switch", { name: "deploy" }).click();
	await settings.waitForFunction(
		() => window.lastSkillToggle?.enabled === true,
	);
	if (shots)
		await settings.screenshot({ path: `${shots}/settings-skills.png` });
	assert.deepEqual(errors, []);
	console.log(
		"PASS: automatic return, browse, show more, connect, details, disconnect, OAuth pending, connected tab, and settings toggles",
	);
} finally {
	await browser?.close();
	await server.close();
}
