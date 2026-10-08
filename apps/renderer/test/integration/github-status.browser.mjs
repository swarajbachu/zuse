import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createServer } from "vite-plus";

const root = resolve(import.meta.dirname, "../..");
export async function statusFixture() {
	const server = await createServer({
		root,
		configFile: resolve(root, "vite.config.ts"),
		server: {
			host: "127.0.0.1",
			port: 15829,
			strictPort: false,
			open: false,
			hmr: false,
			watch: null,
		},
		plugins: [
			{
				name: "github-status-probe",
				enforce: "pre",
				configureServer(server) {
					server.middlewares.use("/__github_status", async (_req, res) => {
						res.setHeader("Content-Type", "text/html");
						res.end(
							await server.transformIndexHtml(
								"/__github_status.html",
								'<div id="root"></div><script type="module" src="/@id/__x00__github-status-probe"></script>',
							),
						);
					});
				},
				resolveId(id) {
					if (id === "\0github-status-probe") return id;
				},
				load(id) {
					if (id !== "\0github-status-probe") return;
					return `
   import React from 'react'; import {createRoot} from 'react-dom/client';
   import {GitHubStatusNotice} from '/src/components/github-status-notice.tsx';
   import {PrActionsMenu} from '/src/components/pr-actions-menu.tsx';
   import {resolveGitPrState} from '/src/lib/git-pr-state.ts';
   import '/src/styles.css';
   const base = {state:'open',branch:'feature',baseBranch:'main',number:1,url:'https://github.com/acme/app/pull/1',nodeId:'PR_1',isDraft:false,checks:'success',checksTotal:1,checksRunning:0,checksPassing:1,checksFailing:0,autoMergeEnabled:false,mergeable:'clean',additions:1,deletions:0,checkRuns:[{name:'build',status:'completed',conclusion:'success',url:null}],checksComplete:true,prCapability:'available',stale:false};
   const states = [{name:'Fresh',pr:base},{name:'Loading',pr:{...base,state:'none',stale:true,checks:'none',checkRuns:[]}},{name:'Offline',pr:{...base,stale:true,prCapability:'offline'}},{name:'Authentication',pr:{...base,stale:true,prCapability:'authentication'}},{name:'Rate limited',pr:{...base,stale:true,prCapability:'rate_limited',retryAt:new Date(Date.now()+60000)}},{name:'Incomplete',pr:{...base,checksComplete:false}}];
   const ref={environmentId:'local',folderId:'probe',worktreeId:null};
   document.documentElement.classList.add('dark');
   createRoot(document.getElementById('root')).render(React.createElement('main',{style:{width:620,margin:'64px auto'},className:'text-foreground'},React.createElement('h1',{className:'mb-4 text-lg font-medium'},'GitHub status'),states.map(({name,pr})=>{const state=resolveGitPrState(pr,null,'feature');return React.createElement('section',{key:name,'data-state':name,className:'mb-2 flex h-10 items-center justify-between rounded-md bg-muted/20 px-3'},React.createElement('span',{className:'w-28 text-xs'},name),React.createElement('span',{className:'text-xs'},state.pr.checks),React.createElement(GitHubStatusNotice,{pr:state.pr,executionRef:ref}),React.createElement(PrActionsMenu,{pr:state.pr,executionRef:ref,className:'flex h-7 items-center gap-1 rounded px-1.5 text-xs',details:null,sessionId:null,onView:()=>{},onChat:()=>{}}));})));
  `;
				},
			},
		],
	});
	await server.listen();
	return {
		server,
		url: `http://127.0.0.1:${server.httpServer.address().port}/__github_status`,
	};
}
if (process.env.ZUSE_STATUS_PROBE === "1") {
	const { url } = await statusFixture();
	console.log(url);
} else {
	const { chromium } = await import("@playwright/test");
	const { server, url } = await statusFixture();
	const browser = await chromium.launch({
		headless: true,
		executablePath: process.env.CHROME_PATH,
	});
	try {
		const page = await browser.newPage();
		const errors = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto(url);
		await page
			.getByRole("button", { name: "GitHub offline · Cached status" })
			.waitFor();
		assert.equal(
			await page
				.getByRole("button", { name: "GitHub rate limited · Refresh paused" })
				.isDisabled(),
			true,
		);
		assert.equal(
			await page
				.locator('[data-state="Incomplete"]')
				.textContent()
				.then((text) => text.includes("pending")),
			true,
		);
		assert.equal(
			await page
				.getByRole("button", { name: "Reconnect GitHub" })
				.evaluate((el) => el.getBoundingClientRect().height),
			28,
		);
		for (const name of ["Offline", "Incomplete"]) {
			await page
				.locator(`[data-state="${name}"]`)
				.getByRole("button", { name: "PR #1", exact: true })
				.click();
			await page
				.getByRole("menuitem", { name: "Merge", exact: true })
				.first()
				.hover();
			await page.getByRole("menu", { name: "Merge", exact: true }).waitFor();
			assert.equal(
				await page
					.getByRole("menuitem", { name: "Merge", exact: true })
					.last()
					.getAttribute("aria-disabled"),
				"true",
			);
			await page.keyboard.press("Escape");
			await page.keyboard.press("Escape");
		}

		assert.deepEqual(errors, []);
		if (process.env.ZUSE_STATUS_SCREENSHOT)
			await page.screenshot({
				path: resolve(root, "../../.context/github-status.png"),
			});
		console.log("GitHub status browser checks passed");
	} finally {
		await browser.close();
		await server.close();
	}
}
