import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite-plus";

// Real review components/stores/styles; auth, HTTP and composer dispatch are fixture boundaries.
const root = resolve(import.meta.dirname, "../..");
const cacheDir = await mkdtemp(resolve(root, ".review-browser-"));
const virtual = (name) => `\0review-fixture-${name}`;
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
			name: "review-browser-fixture",
			enforce: "pre",
			configureServer(server) {
				server.middlewares.use("/__review", async (_request, response) => {
					response.setHeader("Content-Type", "text/html");
					response.end(
						await server.transformIndexHtml(
							"/__review.html",
							'<div id="root"></div><script type="module" src="/@id/__x00__review-fixture-entry"></script>',
						),
					);
				});
			},
			resolveId(id, importer) {
				if (id.startsWith("\0review-fixture-")) return id;
				const subject =
					importer?.includes("review-pane.tsx") ||
					importer?.includes("review-draft-banner.tsx");
				if (subject && id.endsWith("use-auth.ts")) return virtual("auth");
				if (subject && id.endsWith("control-plane-client.ts"))
					return virtual("client");
				if (
					(subject || importer?.includes("review-draft.ts")) &&
					id.endsWith("renderer-account.ts")
				)
					return virtual("account");
				if (subject && id.endsWith("renderer-workspace.ts"))
					return virtual("workspace");
				if (subject && id.endsWith("store/chats.ts")) return virtual("chats");
				if (subject && id.endsWith("store/ui.ts")) return virtual("ui");
				if (subject && id.endsWith("store/composer-drafts.ts"))
					return virtual("composer");
			},
			load(id) {
				if (id === virtual("auth"))
					return `
        import {useSyncExternalStore} from 'react';
        let signedIn=false;
        const listeners=new Set();
        export const useAuth=()=>({isSignedIn:useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>signedIn),isLoading:false,signingIn:false,signIn:async()=>{signedIn=true;for(const fn of listeners)fn()}});
      `;
				if (id === virtual("account"))
					return `const value={epoch:1}; export const rendererAccountSnapshot=()=>value;export const subscribeRendererAccount=()=>()=>{};`;
				if (id === virtual("workspace"))
					return `const value={key:'fixture',epoch:1};export const rendererWorkspaceSnapshot=()=>value;export const subscribeRendererWorkspace=()=>()=>{};`;
				if (id === virtual("chats"))
					return `export const useChatsStore={getState:()=>({select:id=>{window.fixture.selectedChat=id}})};`;
				if (id === virtual("ui"))
					return `export const useUiStore={getState:()=>({setView:view=>{window.fixture.view=view;window.dispatchEvent(new Event('fixture-view'))}})};`;
				if (id === virtual("composer"))
					return `export const useComposerDraftsStore={getState:()=>({addContext:(key,context)=>{window.fixture.contexts.push({key,context});window.dispatchEvent(new Event('fixture-context'))}})};`;
				if (id === virtual("client"))
					return `export const runCloudControl=operation=>operation(new Proxy({}, {get:(_target,name)=>async input=>{
        window.fixture.requests.push({name,input});
        if(name==='review.coverage')return {available:false,reason:'provider_verification_required',providers:[],enrollments:[]};
        if(name==='review.runs')return {items:window.fixture.runs.map(({result,...summary})=>summary)};
        if(name==='review.get')return window.fixture.runs.find(run=>run.id===input.id);
        if(name==='review.fixContext')return window.fixture.context;
        throw new Error('Unexpected transport operation: '+name);
      }}));`;
				if (id === virtual("entry"))
					return `
        import React,{useEffect,useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {ReviewPane} from '/src/components/settings/review-pane.tsx';
        import {ReviewDraftBanner} from '/src/components/review-draft-banner.tsx';
        import {useReviewHandoffStore} from '/src/store/review-handoff.ts';
        import '/src/styles.css';
        const snapshot={repositoryId:1,baseRef:'main',baseSha:'a'.repeat(40),mergeBaseSha:'a'.repeat(40),headSha:'b'.repeat(40)};
        const finding={id:'finding-1',severity:'high',title:'Guard absent before dereference',explanation:'An empty response can reach the caller.',trigger:'Empty response',consequence:'Caller throws',location:{path:'src/read.ts',side:'RIGHT',startLine:2,endLine:2},evidence:[{path:'src/read.ts',side:'RIGHT',startLine:2,endLine:2,quote:'return response.value'}]};
        const base={repositoryId:1,repositoryFullName:'example/review-fixture',pullNumber:42,baseRef:'main',baseSha:snapshot.baseSha,headSha:snapshot.headSha,enrollmentId:'enrollment',enrollmentVersion:1,ownerId:'fixture-account',modelConnectionId:'fixture-connection',agentProvider:'codex',model:'fixture-model',worker:{provider:'e2b',size:'small',maxRuntimeMs:600000},createdAtMs:1,updatedAtMs:2};
        const partial={snapshot,status:'partial',reason:'coverage_limit',findings:[finding],coverage:{eligibleFiles:4,reviewedFiles:2,excludedFiles:1,unreviewedPaths:['src/other.ts','src/test.ts'],contextLimited:false}};
        window.fixture={requests:[],contexts:[],view:'settings',runs:[{...base,id:'run-partial',state:'partial',result:partial},{...base,id:'run-complete',pullNumber:43,state:'completed',result:{...partial,status:'completed',reason:undefined,findings:[],coverage:{...partial.coverage,reviewedFiles:4,unreviewedPaths:[]}}},{...base,id:'run-blocked',pullNumber:44,state:'blocked',blockedReason:'provider_verification_required'}],context:{runId:'run-partial',repositoryId:1,repositoryFullName:base.repositoryFullName,pullNumber:42,snapshot,findings:[finding,{...finding,id:'finding-2',title:'Unselected finding'}],currentHeadSha:'c'.repeat(40)}};
        useReviewHandoffStore.getState().accept({runId:'run-partial',findingId:'finding-1'});
        document.documentElement.classList.add('dark');
        function Fixture(){
          const [view,setView]=useState('settings'); const [repository,setRepository]=useState('github.com/example/wrong'); const [count,setCount]=useState(0);
          useEffect(()=>{const onView=()=>setView(window.fixture.view); const onContext=()=>setCount(window.fixture.contexts.length);window.addEventListener('fixture-view',onView);window.addEventListener('fixture-context',onContext);return()=>{window.removeEventListener('fixture-view',onView);window.removeEventListener('fixture-context',onContext)}},[]);
          return React.createElement('main',{style:{padding:16,width:'100%',boxSizing:'border-box'}}, view==='settings'?React.createElement(ReviewPane):React.createElement(React.Fragment,null,
            React.createElement('label',null,'Fixture destination',React.createElement('select',{'aria-label':'Fixture destination',value:repository,onChange:event=>setRepository(event.target.value)},React.createElement('option',{value:'github.com/example/wrong'},'Other repository'),React.createElement('option',{value:'github.com/example/review-fixture'},'Review repository'))),
            React.createElement(ReviewDraftBanner,{draftKey:'fixture-draft',repositoryIdentity:repository}),React.createElement('p',null,'Attached contexts: '+count)));
        }
        createRoot(document.getElementById('root')).render(React.createElement(Fixture));
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
		executablePath: process.env.CHROME_PATH,
	});
	const page = await browser.newPage({ viewport: { width: 720, height: 480 } });
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(
		`http://127.0.0.1:${server.httpServer.address().port}/__review`,
	);
	await page
		.getByRole("button", { name: "Sign in", exact: true })
		.waitFor({ timeout: 30000 });
	assert.deepEqual(await page.evaluate(() => window.fixture.requests), []);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await page
		.getByText("Automatic reviews are not available yet", { exact: true })
		.waitFor();
	await page
		.getByRole("checkbox", { name: /Guard absent before dereference/ })
		.waitFor();
	assert.equal(
		await page
			.getByRole("checkbox", { name: /Guard absent before dereference/ })
			.isChecked(),
		true,
	);
	assert.equal(
		await page
			.getByRole("checkbox", { name: /Unselected finding/ })
			.isChecked(),
		false,
	);
	await page.getByText(/The PR has changed since this review/).waitFor();
	const retries = page.getByRole("button", {
		name: "Retry review",
		exact: true,
	});
	assert.equal(await retries.count(), 3);
	for (const retry of await retries.all())
		assert.equal(await retry.isDisabled(), true);
	const details = page.locator("summary").filter({ hasText: "Review details" });
	await details.nth(0).focus();
	await page.keyboard.press("Enter");
	assert.equal(
		await details.nth(0).evaluate((element) => element.parentElement.open),
		true,
	);
	await page
		.getByText("Reviewed 2 of 4 eligible files; 1 excluded.", { exact: true })
		.waitFor();
	await page
		.getByText("Maximum worker runtime: 10 minutes", { exact: true })
		.first()
		.waitFor();
	assert.equal(
		await page.getByText("No findings", { exact: true }).isVisible(),
		false,
	);
	await details.nth(1).focus();
	await page.keyboard.press("Enter");
	await page.getByText("No findings", { exact: true }).waitFor();
	assert.equal(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
		true,
	);
	await page.evaluate(() => window.scrollTo(0, 0));
	await mkdir(resolve(root, "../../.context"), { recursive: true });
	await page.screenshot({
		path: resolve(root, "../../.context/review-720.png"),
	});
	await page
		.getByRole("button", { name: "Choose workspace and agent", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Attach findings to draft", exact: true })
		.waitFor();
	assert.equal(await page.evaluate(() => window.fixture.contexts.length), 0);
	await page
		.getByRole("button", { name: "Attach findings to draft", exact: true })
		.click();
	await page.getByRole("status").waitFor();
	assert.match(
		await page.getByRole("status").innerText(),
		/example\/review-fixture/,
	);
	assert.equal(await page.evaluate(() => window.fixture.contexts.length), 0);
	await page
		.getByRole("combobox", { name: "Fixture destination" })
		.selectOption("github.com/example/review-fixture");
	await page
		.getByRole("button", { name: "Attach findings to draft", exact: true })
		.click();
	await page.getByText("Attached contexts: 1", { exact: true }).waitFor();
	const captured = await page.evaluate(() => window.fixture);
	assert.match(
		captured.contexts[0].context.text,
		/Guard absent before dereference/,
	);
	assert.doesNotMatch(captured.contexts[0].context.text, /Unselected finding/);
	assert.equal(captured.contexts[0].key, "fixture-draft");
	assert.ok(
		captured.requests.every((request) =>
			[
				"review.coverage",
				"review.runs",
				"review.get",
				"review.fixContext",
			].includes(request.name),
		),
	);
	assert.deepEqual(errors, []);
	console.log(
		"PASS: real review UI sign-in continuation, blocked retry, partial/complete states, keyboard details, 720px layout and explicit draft-only fix handoff; HTTP/auth/composer boundaries mocked.",
	);
} finally {
	await browser?.close();
	await server.close();
	await rm(cacheDir, { recursive: true, force: true });
}
