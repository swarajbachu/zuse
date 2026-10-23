import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite-plus";

const root = resolve(import.meta.dirname, "../..");
const cacheDir = await mkdtemp(resolve(root, ".workflow-results-probe-"));
const entry = `import '/src/styles.css';
import React from 'react';
import {createRoot} from 'react-dom/client';
import {DelegationGroup} from '/src/components/delegation-group.tsx';
import {groupMessages} from '/src/lib/group-messages.ts';
import {WorkflowRun} from '/src/components/workflow-run.tsx';
const e=React.createElement;
const message=(id,content)=>({id,sessionId:'test-session',role:'assistant',createdAt:new Date(),content});
const run=(name,failed)=>{
 const itemId=name;
 const summary=(failed?'Invalid workflow script. ':'Completed workflow. ')+('Full diagnostic detail. '.repeat(30))+(failed?'ERROR END MARKER':'RESULT END MARKER');
 const groups=groupMessages([
  message(name,{_tag:'tool_use',itemId,tool:'Workflow',input:{name,prompt:'Review changes'}}),
  message(name+'-summary',{_tag:'subagent_summary',itemId,agentName:name,model:'inherit',turns:1,durationMs:1000,summary,isError:failed}),
 ]);
 return e(DelegationGroup,{key:name,members:[{kind:'subagent',id:name,group:groups[0]}],providerId:'claude',parentLive:false,chatRef:null,readOnly:true});
};
window.openCount=0;
createRoot(document.getElementById('root')).render(e('main',{style:{maxWidth:800,margin:'32px auto'}},
 run('rejected-launch',true),run('completed-run',false),
 e(WorkflowRun,{input:{name:'detached-run'},view:{id:'detached',title:'detached-run',status:'done',detail:'Complete',providerId:'claude',startedAt:1,completedAt:1001,open:null},onOpen:()=>{window.openCount++;}})
));
`;
const server = await createServer({
	root,
	configFile: resolve(root, "vite.config.ts"),
	cacheDir,
	server: {
		host: "127.0.0.1",
		port: 15847,
		strictPort: false,
		open: false,
		hmr: false,
		watch: null,
	},
	plugins: [
		{
			name: "workflow-results-probe",
			configureServer(server) {
				server.middlewares.use("/__results", async (_req, res) => {
					res.setHeader("Content-Type", "text/html");
					res.end(
						await server.transformIndexHtml(
							"/__results.html",
							'<div id="root"></div><script type="module" src="/@id/__x00__workflow-results"></script>',
						),
					);
				});
			},
			resolveId(id) {
				if (id === "\0workflow-results") return id;
			},
			load(id) {
				if (id === "\0workflow-results") return entry;
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
		`http://127.0.0.1:${server.httpServer.address().port}/__results`,
	);
	for (const [name, ending] of [
		["rejected-launch", "ERROR END MARKER"],
		["completed-run", "RESULT END MARKER"],
	]) {
		const run = page.getByRole("region", {
			name: `Workflow: ${name}`,
			exact: true,
		});
		const button = run.getByRole("button", {
			name: "Open Result",
			exact: true,
		});
		await button.click();
		assert.equal(await button.getAttribute("aria-expanded"), "true");
		assert.equal(
			await run.getByText(new RegExp(ending)).last().isVisible(),
			true,
		);
		await button.click();
		assert.equal(await button.getAttribute("aria-expanded"), "false");
	}
	await page
		.getByRole("region", { name: "Workflow: detached-run", exact: true })
		.getByRole("button", { name: "Open Result", exact: true })
		.click();
	assert.equal(await page.evaluate(() => window.openCount), 1);
	assert.deepEqual(errors, []);
	console.log(
		"Passed: full rejected-launch error, completed result, and detached open action.",
	);
} finally {
	await browser?.close();
	await server.close();
	await rm(cacheDir, { recursive: true, force: true });
}
