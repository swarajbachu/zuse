import assert from "node:assert/strict";
import { createServer } from "node:http";
import { prepareHtmlDocument } from "@zuse/utils/html-document";
import { app, BrowserWindow, protocol, session } from "electron";
import {
	guardHtmlVisualNavigation,
	installHtmlVisualNetwork,
	VISUAL_ASSET_SCHEMES,
} from "../../src/html-visual-network.ts";

protocol.registerSchemesAsPrivileged(
	VISUAL_ASSET_SCHEMES.map((scheme) => ({
		scheme,
		privileges: {
			standard: true,
			secure: true,
			corsEnabled: true,
			supportFetchAPI: true,
			stream: true,
		},
	})),
);
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-quic");

async function run() {
	await app.whenReady();
	let privateHits = 0;
	const server = createServer((req, res) => {
		if (req.url?.startsWith("/private")) privateHits++;
		res.end("<div>Host</div>");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	const local = `http://127.0.0.1:${address.port}/private`;
	const close = installHtmlVisualNetwork(session.defaultSession);
	const win = new BrowserWindow({
		show: false,
		webPreferences: { sandbox: true, nodeIntegration: false },
	});
	guardHtmlVisualNavigation(win.webContents);
	try {
		await session.defaultSession.cookies.set({
			url: "https://httpbingo.org",
			name: "visual_app_secret",
			value: "must-not-leave-app-session",
			secure: true,
			sameSite: "no_restriction",
		});
		await win.loadURL(`http://127.0.0.1:${address.port}/`);
		const body = prepareHtmlDocument(`<script>
 window.results={};
 async function run(){
  for (const [key,url] of Object.entries({loopback:${JSON.stringify(local)},hostname:${JSON.stringify(local.replace("127.0.0.1", "localhost"))},redirect:${JSON.stringify(`https://httpbingo.org/redirect-to?url=${encodeURIComponent(local)}`)},headers:'https://httpbingo.org/headers'})) {
   try {const r=await fetch(url);results[key]={status:r.status,text:await r.text()}} catch(e){results[key]={error:String(e)}}
  }
  await new Promise(resolve=>{const image=new Image();image.onload=image.onerror=resolve;image.src=${JSON.stringify(`${local}?image`)}});
  await new Promise(resolve=>{const script=document.createElement('script');script.onload=script.onerror=resolve;script.src='https://cdn.jsdelivr.net/npm/dayjs@1/dayjs.min.js';document.head.append(script)});
  results.library=typeof dayjs;
  parent.postMessage(results,'*');
 }
 run();
 </script>`);
		const src = `data:text/html;base64,${Buffer.from(body).toString("base64")}`;
		await win.webContents.executeJavaScript(
			`window.visualResults=null;window.addEventListener('message',e=>{if(e.source===document.querySelector('iframe').contentWindow)window.visualResults=e.data});const frame=document.createElement('iframe');frame.sandbox='allow-scripts';frame.src=${JSON.stringify(src)};document.body.append(frame);`,
		);
		const deadline = Date.now() + 90_000;
		let result: {
			library: string;
			headers: { status: number; text: string };
			loopback: { error?: string; status: number };
			hostname: { error?: string; status: number };
			redirect: { error?: string; status: number };
		} | null = null;
		while (Date.now() < deadline) {
			result = await win.webContents.executeJavaScript("window.visualResults");
			if (result) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert(result, "visual requests timed out");
		assert.equal(result.library, "function", "public script failed to execute");
		assert.equal(result.headers.status, 200, "public fetch failed");
		assert(
			!result.headers.text.includes("must-not-leave-app-session"),
			"application cookie leaked",
		);
		assert.equal(privateHits, 0, "private-network traffic reached the server");
		for (const key of ["loopback", "hostname", "redirect"] as const)
			assert(
				result[key].error || result[key].status >= 400,
				`${key} was not blocked`,
			);
		await win.webContents.executeJavaScript(
			`document.querySelector('iframe').contentWindow.postMessage('navigate','*')`,
		);
		// Trigger navigation inside the sandbox, with CDP rather than a privileged parent bridge.
		const frame = win.webContents.mainFrame.frames[0];
		assert(frame);
		await frame
			.executeJavaScript(`location.href=${JSON.stringify(local)}`)
			.catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(privateHits, 0, "visual navigated to a local service");
		assert(frame.url.startsWith("data:text/html;base64,"));
		console.log(
			"Published visual Electron checks passed: public library/fetch, private IP/hostname/redirect/image, credentials and navigation.",
		);
	} finally {
		win.destroy();
		await close();
		server.close();
		app.quit();
	}
}
void run().catch((error) => {
	console.error(error);
	app.exit(1);
});
