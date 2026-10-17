import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChatId } from "@zuse/contracts";
import { expect, it, vi } from "vitest";
import {
	npmToolDirectory,
	npmToolEntry,
} from "../../src/process/npm-tool-installer.ts";
import {
	SimulatorController,
	type SimulatorPreferences,
} from "../../src/simulators/controller.ts";
import { SIMULATOR_TOOLS } from "../../src/simulators/toolchain.ts";

it("isolates concurrent chats, streams through the owned helper and reconnects after disabling", async () => {
	const root = await mkdtemp(join(tmpdir(), "zuse-simulator-hub-"));
	let preferences: SimulatorPreferences = {
		enabled: true,
		agentAccessEnabled: true,
		onboardingCompleted: true,
	};
	const entry = npmToolEntry(join(root, "tools"), SIMULATOR_TOOLS.hub);
	await mkdir(dirname(entry), { recursive: true });
	await writeFile(
		entry,
		`
 import http from 'node:http';
 const port = Number(process.argv[process.argv.indexOf('--port')+1]);
 const server=http.createServer((req,res)=>{
  if(req.url==='/api/devices'){res.setHeader('content-type','application/json');res.end(JSON.stringify({simulators:[{id:'ABC-123',name:'Test iPhone',version:'iOS 26',booted:false,platform:'ios'}]}));}
  else if(req.url?.endsWith('/config')){res.setHeader('content-type','application/json');res.end(JSON.stringify({width:390,height:844,orientation:'portrait'}));}
  else if(req.url?.endsWith('/stream.mjpeg')){res.write(Buffer.from([255,216,1,255,217]));}
  else if(req.url?.endsWith('/stream.avcc')){res.write(Buffer.from([0,0,0,3,2,8,9]));const timer=setInterval(()=>res.write(Buffer.from([0,0,0,3,3,8,9])),30);res.on('close',()=>clearInterval(timer));}
  else if(req.url?.startsWith('/vendor/serve-sim/api/screenshot')){res.end(Buffer.from('png'));}
  else {res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true}));}
 });server.listen(port,'127.0.0.1');
 `,
	);
	await writeFile(
		join(
			npmToolDirectory(join(root, "tools"), SIMULATOR_TOOLS.hub),
			".install-complete",
		),
		SIMULATOR_TOOLS.hub.version,
	);
	const controller = new SimulatorController({
		root,
		platform: "darwin",
		run: vi.fn(async () => ""),
		preferences: async () => preferences,
		savePreferences: async (value) => {
			preferences = value;
		},
		publish: () => {},
	});
	try {
		await controller.initialize();
		const first = { chatId: ChatId.make("first-chat"), deviceId: "ABC-123" },
			second = { ...first, chatId: ChatId.make("second-chat") };
		const opens = await Promise.allSettled([
			controller.open(first),
			controller.open(second),
		]);
		expect(opens[0]?.status).toBe("fulfilled");
		expect(opens[1]?.status).toBe("rejected");
		expect(controller.state.sessions.map((session) => session.chatId)).toEqual([
			first.chatId,
		]);
		expect(await controller.screenshot(first, true)).toBe(
			Buffer.from("png").toString("base64"),
		);
		await expect(controller.screenshot(second, true)).rejects.toThrow(
			"current chat",
		);
		const frames = controller.frames(
			first,
			"avcc",
			new AbortController().signal,
		);
		expect((await frames.next()).value?.tag).toBe(130);
		expect((await frames.next()).value).toEqual({ tag: 2, data: "CAk=" });

		const sent: Buffer[] = [];
		let admitted = false;
		class InputSocket extends EventTarget {
			static OPEN = 1;
			readyState = 1;
			binaryType = "arraybuffer";
			constructor() {
				super();
				queueMicrotask(() => {
					this.dispatchEvent(new Event("open"));
					setTimeout(() => {
						admitted = true;
						this.dispatchEvent(
							new MessageEvent("message", {
								data: Uint8Array.from([131]).buffer,
							}),
						);
					}, 5);
				});
			}
			send(value: Buffer) {
				if (value[0] === 3) expect(admitted).toBe(true);
				sent.push(value);
			}
			close() {
				this.readyState = 3;
				this.dispatchEvent(new Event("close"));
			}
		}
		vi.stubGlobal("WebSocket", InputSocket);
		await controller.input(first, {
			_tag: "touch",
			phase: "begin",
			x: 0.2,
			y: 0.4,
		});
		expect(sent.map((value) => value[0])).toEqual([13, 3]);
		await controller.close(first);
		await expect(frames.next()).rejects.toThrow();
		await controller.open(second);
		preferences = { ...preferences, enabled: false, agentAccessEnabled: false };
		await controller.reconcile(preferences);
		expect(controller.state.status).toBe("disabled");
		await expect(
			controller.input(second, { _tag: "button", button: "home" }),
		).rejects.toThrow("off");
		preferences = { ...preferences, enabled: true };
		await controller.reconcile(preferences);
		await controller.refresh();
		expect(controller.state.status).toBe("ready");
	} finally {
		await controller.dispose();
		vi.unstubAllGlobals();
		await rm(root, { recursive: true, force: true });
	}
}, 15000);

it("boots an Android emulator by AVD name and follows it under its serial", async () => {
	const root = await mkdtemp(join(tmpdir(), "zuse-emulator-hub-"));
	const sdk = join(root, "Android", "Sdk");
	for (const tool of [
		join(sdk, "platform-tools", "adb"),
		join(sdk, "emulator", "emulator"),
		join(sdk, "cmdline-tools", "latest", "bin", "avdmanager"),
		join(root, ".android", "avd", "Fresh_AVD.ini"),
	]) {
		await mkdir(dirname(tool), { recursive: true });
		await writeFile(tool, "");
	}
	const entry = npmToolEntry(join(root, "tools"), SIMULATOR_TOOLS.hub);
	await mkdir(dirname(entry), { recursive: true });
	await writeFile(
		entry,
		`
 import http from 'node:http';
 const port = Number(process.argv[process.argv.indexOf('--port')+1]);
 let booted = false; const requests = [];
 const json = (res, body) => { res.setHeader('content-type','application/json'); res.end(JSON.stringify(body)); };
 http.createServer((req,res)=>{
  let body=''; req.on('data', c => body += c); req.on('end', () => {
   if (req.url==='/api/devices') return json(res,{simulators:[],emulators:[
    booted ? {id:'emulator-5554',name:'Pixel_8',version:'Android 15.0',platform:'android',booted:true}
           : {id:'Pixel_8',name:'Pixel_8',version:'Android 15.0',platform:'android',booted:false},
    {id:'R5CT',name:'Phone',version:'Android 14.0',platform:'android',booted:true,physical:true}]});
   if (req.url==='/api/devices/boot') { const action = JSON.parse(body); if (action.platform !== 'android' || action.name !== 'Pixel_8') return json(res,{ok:false,error:'bad boot'}); booted = true; return json(res,{ok:true,id:'emulator-5554'}); }
   if (req.url==='/api/devices/shutdown') { const action = JSON.parse(body); booted = !(action.platform==='android' && action.id==='emulator-5554'); return json(res,{ok:!booted}); }
   if (req.url?.startsWith('/vendor/serve-emu/api/screenshot?device=emulator-5554') && req.method==='POST') return res.end(Buffer.from('android-png'));
   res.statusCode = 404; res.end();
  });
 }).listen(port,'127.0.0.1');
 `,
	);
	await writeFile(
		join(
			npmToolDirectory(join(root, "tools"), SIMULATOR_TOOLS.hub),
			".install-complete",
		),
		SIMULATOR_TOOLS.hub.version,
	);
	const controller = new SimulatorController({
		root,
		platform: "linux",
		env: { PATH: "" },
		home: root,
		run: vi.fn(async () => ""),
		preferences: async () => ({
			enabled: true,
			agentAccessEnabled: false,
			onboardingCompleted: true,
		}),
		savePreferences: async () => {},
		publish: () => {},
	});
	try {
		await controller.initialize();
		await controller.refresh();
		// Physical phones are excluded; never-booted AVDs come from the AVD home.
		expect(controller.state.devices).toEqual([
			{
				id: "Pixel_8",
				platform: "android",
				name: "Pixel 8",
				version: "Android 15.0",
				booted: false,
			},
			{
				id: "Fresh_AVD",
				platform: "android",
				name: "Fresh AVD",
				version: "Android",
				booted: false,
			},
		]);
		const chatId = ChatId.make("android-chat");
		const opened = await controller.open({ chatId, deviceId: "Pixel_8" });
		expect(opened).toMatchObject({ id: "emulator-5554", booted: true });
		const target = { chatId, deviceId: "emulator-5554" };
		expect(controller.state.sessions).toEqual([
			expect.objectContaining(target),
		]);
		expect(await controller.screenshot(target)).toBe(
			Buffer.from("android-png").toString("base64"),
		);

		const sockets: Array<{ url: string; sent: string[] }> = [];
		class EmuSocket extends EventTarget {
			static OPEN = 1;
			readyState = 1;
			binaryType = "blob";
			sent: string[] = [];
			constructor(readonly url: string) {
				super();
				sockets.push(this);
				queueMicrotask(() => {
					this.dispatchEvent(new Event("open"));
					if (!url.includes("frame-meta=1")) return;
					const header = Buffer.alloc(24);
					header.writeUInt32BE(0x53454d55, 0);
					header[4] = 2;
					header[5] = 1;
					const frame = Buffer.concat([
						header,
						Buffer.from([0, 0, 0, 1, 0x65]),
					]);
					this.dispatchEvent(
						new MessageEvent("message", {
							data: frame.buffer.slice(
								frame.byteOffset,
								frame.byteOffset + frame.length,
							),
						}),
					);
				});
			}
			send(value: string) {
				this.sent.push(value);
			}
			close() {
				this.readyState = 3;
				this.dispatchEvent(Object.assign(new Event("close"), { code: 1000 }));
			}
		}
		vi.stubGlobal("WebSocket", EmuSocket);
		const frames = controller.frames(
			target,
			"avcc",
			new AbortController().signal,
		);
		expect((await frames.next()).value).toEqual({
			tag: 16,
			data: Buffer.from([0, 0, 0, 1, 0x65]).toString("base64"),
		});
		expect(sockets[0]?.sent).toEqual([
			JSON.stringify({ type: "reset-video", ack: false }),
		]);
		await controller.input(target, { _tag: "button", button: "back" });
		await controller.input(target, { _tag: "text", text: "a" });
		expect(sockets[1]?.url).toContain("video=0");
		expect(sockets[1]?.sent).toEqual([
			JSON.stringify({ type: "back" }),
			JSON.stringify({ type: "text", text: "a" }),
		]);
		await frames.return(undefined);
		await controller.close(target, true);
		expect(controller.state.sessions).toEqual([]);
		expect(
			controller.state.devices.find((device) => device.id === "emulator-5554")
				?.booted,
		).toBe(false);
	} finally {
		await controller.dispose();
		vi.unstubAllGlobals();
		await rm(root, { recursive: true, force: true });
	}
}, 15000);
