import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChatId } from "@zuse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	installNpmTool,
	isNpmToolInstalled,
	npmToolEntry,
} from "../../src/process/npm-tool-installer.ts";
import {
	SimulatorController,
	type SimulatorPreferences,
} from "../../src/simulators/controller.ts";
import {
	ANDROID_DELTA_PACKET,
	ANDROID_KEY_PACKET,
	ANDROID_RESET_PACKET,
	androidGesture,
	androidVideoPacket,
	readBounded,
	SimulatorPacketParser,
} from "../../src/simulators/protocol.ts";
import { supportedDeviceNode } from "../../src/simulators/toolchain.ts";

const temporary: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of temporary.splice(0))
		await rm(root, { recursive: true, force: true });
});
async function directory() {
	const dir = await mkdtemp(join(tmpdir(), "zuse-simulator-test-"));
	temporary.push(dir);
	return dir;
}
describe("pinned simulator tools", () => {
	const spec = { name: "test-helper", version: "1.2.3", entry: ["bin.mjs"] };
	it("shares concurrent installs and never publishes incomplete files", async () => {
		const root = await directory();
		let release: () => void = () => {};
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const runner = vi.fn(async (args: readonly string[]) => {
			const staging = args[2];
			if (!staging) throw Error("Missing prefix");
			await mkdir(join(staging, "node_modules", spec.name), {
				recursive: true,
			});
			await writeFile(
				join(staging, "node_modules", spec.name, "bin.mjs"),
				"done",
			);
			await wait;
		});
		const first = installNpmTool(root, spec, runner),
			second = installNpmTool(root, spec, runner);
		expect(second).toBe(first);
		expect(await isNpmToolInstalled(root, spec)).toBe(false);
		release();
		expect(await first).toBe(npmToolEntry(root, spec));
		expect(await isNpmToolInstalled(root, spec)).toBe(true);
		await installNpmTool(root, spec, runner);
		expect(runner).toHaveBeenCalledTimes(1);
	});
	it("retries failed installs and rejects traversal in package specifications", async () => {
		const root = await directory();
		await expect(
			installNpmTool(root, spec, async () => {
				throw Error("network lost");
			}),
		).rejects.toThrow("network lost");
		expect(await isNpmToolInstalled(root, spec)).toBe(false);
		await expect(
			installNpmTool(root, { ...spec, version: "../escape" }, vi.fn()),
		).rejects.toThrow("Invalid pinned");
		await expect(installNpmTool(root, spec, async () => {})).rejects.toThrow();
	});
	it.each([
		["22.11.9", false],
		["22.12.0", true],
		["24.0.0", true],
		["20.19.0", false],
	])("checks native tool Node requirement %s", (version, supported) => {
		expect(supportedDeviceNode(String(version))).toBe(supported);
	});
});
describe("simulator capability lifecycle", () => {
	async function setup(initial: Partial<SimulatorPreferences> = {}) {
		const root = await directory();
		let preferences: SimulatorPreferences = {
			enabled: false,
			agentAccessEnabled: false,
			onboardingCompleted: false,
			...initial,
		};
		const run = vi.fn(async (..._args: unknown[]) => "");
		const publish = vi.fn();
		const controller = new SimulatorController({
			root,
			env: { PATH: "" },
			home: root,
			platform: "linux",
			run,
			preferences: async () => preferences,
			savePreferences: async (value) => {
				preferences = value;
			},
			publish,
		});
		await controller.initialize();
		return {
			root,
			controller,
			run,
			publish,
			setPreferences: (value: SimulatorPreferences) => {
				preferences = value;
			},
		};
	}
	it("does not install or start anything on initialization or disabled refresh", async () => {
		const { controller, run } = await setup();
		await controller.refresh();
		// Only read-only probes run while support is off.
		expect(run.mock.calls.map((call) => call.slice(0, 2))).toEqual([
			["npm", ["--version"]],
		]);
		expect(controller.state.status).toBe("disabled");
		expect(controller.state.detail).toContain("Android SDK");
		await controller.dispose();
	});
	it("reports each Mac requirement without installing, and only blocks on missing Xcode", async () => {
		const root = await directory();
		const run = vi.fn(async (file: string) => {
			if (file === "xcode-select") throw new Error("not selected");
			if (file === "xcrun") throw new Error("no simctl");
			return "10.0.0";
		});
		const controller = new SimulatorController({
			root,
			env: { PATH: "" },
			home: root,
			platform: "darwin",
			run,
			preferences: async () => ({
				enabled: false,
				agentAccessEnabled: false,
				onboardingCompleted: false,
			}),
			savePreferences: async () => {},
			publish: () => {},
		});
		await controller.initialize();
		await controller.refresh();
		expect(
			controller.state.requirements.map((item) => [item.id, item.ok]),
		).toEqual([
			["xcode", false],
			["runtime", false],
			["android-sdk", false],
			["android-avd", false],
			["node", true],
		]);
		expect(controller.state.detail).toContain("Set up Xcode");
		expect(run.mock.calls.map(([file]) => file).sort()).toEqual([
			"npm",
			"xcode-select",
			"xcrun",
		]);
		await controller.dispose();
	});
	it("offers host fixes and runs the runtime download with live progress", async () => {
		const root = await directory();
		let runtimes = 0;
		const progress: string[] = [];
		const run = vi.fn(
			async (
				file: string,
				args: readonly string[],
				_cwd: string,
				_signal: AbortSignal,
				_timeout?: number,
				_env?: NodeJS.ProcessEnv,
				onOutput?: (chunk: string) => void,
			) => {
				if (file === "xcrun")
					return JSON.stringify({
						devices: {
							"com.apple.CoreSimulator.SimRuntime.iOS-26-1": Array(
								runtimes,
							).fill({}),
						},
					});
				if (file === "xcodebuild" && args[0] === "-downloadPlatform") {
					onOutput?.(
						"Downloading iOS 26.1 Simulator: 42.0% (3.1 GB of 7.4 GB)\r",
					);
					runtimes = 2;
				}
				return "ok";
			},
		);
		const controller = new SimulatorController({
			root,
			env: { PATH: "" },
			home: root,
			platform: "darwin",
			run,
			preferences: async () => ({
				enabled: false,
				agentAccessEnabled: false,
				onboardingCompleted: false,
			}),
			savePreferences: async () => {},
			publish: (state) => {
				const runtime = state.requirements.find(
					(item) => item.id === "runtime",
				);
				if (runtime?.fix?.running) progress.push(runtime.detail);
			},
		});
		await controller.initialize();
		await controller.check();
		expect(
			controller.state.requirements.find((item) => item.id === "runtime")?.fix,
		).toEqual({ label: "Install", running: false });
		await controller.fix("runtime");
		expect(run).toHaveBeenCalledWith(
			"xcodebuild",
			["-downloadPlatform", "iOS"],
			root,
			expect.any(AbortSignal),
			expect.any(Number),
			undefined,
			expect.any(Function),
		);
		expect(progress).toContain(
			"Downloading iOS 26.1 Simulator: 42.0% (3.1 GB of 7.4 GB)",
		);
		expect(
			controller.state.requirements.find((item) => item.id === "runtime"),
		).toMatchObject({ ok: true, detail: "2 iOS simulators" });
		await controller.dispose();
	});
	it("does nothing for requirements that have no fix", async () => {
		const { controller, run } = await setup();
		await controller.fix("runtime");
		expect(run.mock.calls.every(([file]) => file === "npm")).toBe(true);
		// iOS requirements are not offered on Linux.
		expect(controller.state.requirements.map((item) => item.id)).toEqual([
			"android-sdk",
			"android-avd",
			"node",
		]);
		await controller.dispose();
	});
	it("counts available iOS simulators without treating an empty runtime as blocking", async () => {
		const root = await directory();
		const run = vi.fn(async (file: string) =>
			file === "xcrun"
				? JSON.stringify({
						devices: {
							"com.apple.CoreSimulator.SimRuntime.iOS-26-1": [{}, {}],
							"com.apple.CoreSimulator.SimRuntime.watchOS-26-1": [{}],
						},
					})
				: "ok",
		);
		const controller = new SimulatorController({
			root,
			env: { PATH: "" },
			home: root,
			platform: "darwin",
			run,
			preferences: async () => ({
				enabled: false,
				agentAccessEnabled: false,
				onboardingCompleted: false,
			}),
			savePreferences: async () => {},
			publish: () => {},
		});
		await controller.initialize();
		await controller.check();
		expect(
			controller.state.requirements.find((item) => item.id === "runtime"),
		).toMatchObject({ ok: true, detail: "2 iOS simulators" });
		await controller.dispose();
	});
	it("reports a Linux host without trying to install tools", async () => {
		const { controller, run } = await setup({ enabled: true });
		await expect(controller.refresh()).rejects.toThrow("Android SDK");
		expect(controller.state.status).toBe("unavailable");
		expect(run.mock.calls.every(([file]) => file === "npm")).toBe(true);
		await controller.dispose();
	});
	async function androidHost(parts: {
		cmdlineTools?: boolean;
		licensed?: boolean;
		avds?: string[];
	}) {
		const root = await directory();
		const sdk = join(root, "Android", "Sdk");
		const touch = async (path: string) => {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, "");
		};
		await touch(join(sdk, "platform-tools", "adb"));
		await touch(join(sdk, "emulator", "emulator"));
		if (parts.cmdlineTools !== false)
			await touch(join(sdk, "cmdline-tools", "latest", "bin", "avdmanager"));
		if (parts.licensed !== false)
			await touch(join(sdk, "licenses", "android-sdk-license"));
		for (const avd of parts.avds ?? [])
			await touch(join(root, ".android", "avd", `${avd}.ini`));
		const run = vi.fn(async (..._args: unknown[]) => "");
		const controller = new SimulatorController({
			root,
			platform: "linux",
			arch: "x64",
			env: { PATH: "" },
			home: root,
			run: run as never,
			preferences: async () => ({
				enabled: false,
				agentAccessEnabled: false,
				onboardingCompleted: false,
			}),
			savePreferences: async () => {},
			publish: () => {},
		});
		await controller.initialize();
		return { root, sdk, run, controller };
	}
	it("finds an Android SDK and its emulators without starting any tool", async () => {
		const { sdk, run, controller } = await androidHost({
			avds: ["Pixel_8_API_35", "Tablet"],
		});
		await controller.check();
		expect(controller.state.requirements).toEqual([
			expect.objectContaining({ id: "android-sdk", ok: true, detail: sdk }),
			expect.objectContaining({
				id: "android-avd",
				ok: true,
				detail: "2 emulators",
			}),
			expect.objectContaining({ id: "node", ok: true }),
		]);
		expect(run.mock.calls.every(([file]) => file === "npm")).toBe(true);
		await controller.dispose();
	});
	it("offers Command-line Tools when Android Studio left them out", async () => {
		const { controller } = await androidHost({ cmdlineTools: false });
		await controller.check().catch(() => {});
		expect(
			controller.state.requirements.find((item) => item.id === "android-sdk"),
		).toMatchObject({
			ok: false,
			detail: "The Android SDK is missing Command-line Tools.",
			fix: { label: "Install", running: false },
		});
		await controller.dispose();
	});
	it("creates an emulator from the pinned system image", async () => {
		const { sdk, run, controller } = await androidHost({});
		await controller.check();
		expect(
			controller.state.requirements.find((item) => item.id === "android-avd")
				?.fix,
		).toEqual({ label: "Create", running: false });
		await controller.fix("android-avd");
		const calls = run.mock.calls.filter(([file]) => file !== "npm");
		expect(calls.map((call) => call.slice(0, 2))).toEqual([
			[
				join(sdk, "cmdline-tools", "latest", "bin", "sdkmanager"),
				["--install", "system-images;android-35;google_apis;x86_64"],
			],
			[
				join(sdk, "cmdline-tools", "latest", "bin", "avdmanager"),
				[
					"create",
					"avd",
					"--name",
					"Zuse_Pixel_API_35",
					"--package",
					"system-images;android-35;google_apis;x86_64",
					"--device",
					"pixel_8",
				],
			],
		]);
		// SDK tools run with the SDK on PATH.
		expect(calls[0]?.[5]).toMatchObject({ ANDROID_HOME: sdk });
		await controller.dispose();
	});
	it("restores ownership without starting helpers and checks live revocation", async () => {
		const { root, controller, setPreferences } = await setup({
			enabled: true,
			agentAccessEnabled: true,
		});
		const target = { chatId: ChatId.make("chat-a"), deviceId: "ABC-123" };
		await writeFile(
			join(root, "simulators", "sessions.json"),
			JSON.stringify([{ ...target, openedAt: 1 }]),
		);
		await controller.initialize();
		await controller.assertSession(target, true);
		await expect(
			controller.assertSession(
				{ ...target, chatId: ChatId.make("chat-b") },
				true,
			),
		).rejects.toThrow("current chat");
		setPreferences({
			enabled: true,
			agentAccessEnabled: false,
			onboardingCompleted: true,
		});
		await expect(controller.assertSession(target, true)).rejects.toThrow(
			"access is off",
		);
		await controller.assertSession(target);
		await controller.close(target);
		expect(controller.state.sessions).toEqual([]);
		expect(
			JSON.parse(
				await readFile(join(root, "simulators", "sessions.json"), "utf8"),
			),
		).toEqual([]);
		await controller.dispose();
	});
});
describe("bounded native video protocol", () => {
	const semu = (version: 1 | 2, key: boolean, payload: number[]) => {
		const header = Buffer.alloc(version === 1 ? 16 : 24);
		header.writeUInt32BE(0x53454d55, 0);
		header[4] = version;
		header[5] = key ? 1 : 0;
		return Buffer.concat([header, Buffer.from(payload)]);
	};
	it.each([
		1, 2,
	] as const)("strips SEMU v%i headers from Android access units", (version) => {
		expect(androidVideoPacket(semu(version, true, [0, 0, 0, 1, 0x65]))).toEqual(
			{
				tag: ANDROID_KEY_PACKET,
				data: Buffer.from([0, 0, 0, 1, 0x65]).toString("base64"),
			},
		);
		expect(androidVideoPacket(semu(version, false, [0, 0, 1, 0x41]))?.tag).toBe(
			ANDROID_DELTA_PACKET,
		);
	});
	it("detects keyframes in raw Annex-B and encoder restarts", () => {
		expect(
			androidVideoPacket(Buffer.from([0, 0, 1, 0x67, 0, 0, 1, 0x65]))?.tag,
		).toBe(ANDROID_KEY_PACKET);
		expect(androidVideoPacket('{"type":"video-session"}')).toEqual({
			tag: ANDROID_RESET_PACKET,
			data: "",
		});
		expect(androidVideoPacket('{"type":"other"}')).toBeNull();
		expect(androidVideoPacket("not json")).toBeNull();
	});
	it("maps viewer input to Android gestures", () => {
		expect(
			androidGesture({ _tag: "touch", phase: "begin", x: 0.25, y: 1 }),
		).toEqual({ type: "touch", action: "down", x: 0.25, y: 1 });
		expect(androidGesture({ _tag: "button", button: "app_switcher" })).toEqual({
			type: "recents",
		});
		expect(androidGesture({ _tag: "button", button: "lock" })).toEqual({
			type: "power",
		});
		expect(androidGesture({ _tag: "text", text: "hi" })).toEqual({
			type: "text",
			text: "hi",
		});
		expect(androidGesture({ _tag: "keycode", keycode: 67 })).toEqual({
			type: "key",
			keycode: 67,
		});
		expect(
			androidGesture({ _tag: "rotate", orientation: "landscape_left" }),
		).toBeNull();
	});
	it("parses split headers and several AVCC packets in one chunk", () => {
		const parser = new SimulatorPacketParser("avcc");
		const packet = Buffer.from([0, 0, 0, 3, 2, 8, 9]);
		expect(parser.push(packet.subarray(0, 2))).toEqual([]);
		expect(parser.push(Buffer.concat([packet.subarray(2), packet]))).toEqual([
			{ tag: 2, data: "CAk=" },
			{ tag: 2, data: "CAk=" },
		]);
	});
	it("rejects oversized and zero-length native packets", () => {
		expect(() =>
			new SimulatorPacketParser("avcc").push(Buffer.from([0, 0, 0, 0])),
		).toThrow("Invalid");
		expect(() =>
			new SimulatorPacketParser("avcc").push(Buffer.from([127, 255, 255, 255])),
		).toThrow("Invalid");
	});
	it("recovers JPEG frames across fragmented multipart boundaries", () => {
		const parser = new SimulatorPacketParser("mjpeg");
		expect(parser.push(Buffer.from([32, 255]))).toEqual([]);
		expect(parser.push(Buffer.from([216, 1, 255]))).toEqual([]);
		expect(parser.push(Buffer.from([217, 32, 255, 216, 2, 255, 217]))).toEqual([
			{ tag: 4, data: Buffer.from([255, 216, 1, 255, 217]).toString("base64") },
			{ tag: 4, data: Buffer.from([255, 216, 2, 255, 217]).toString("base64") },
		]);
	});
	it("cancels an oversized screenshot body before accumulating it", async () => {
		const cancel = vi.fn();
		const response = new Response(
			new ReadableStream({
				start(c) {
					c.enqueue(new Uint8Array(4));
					c.enqueue(new Uint8Array(4));
				},
				cancel,
			}),
		);
		await expect(readBounded(response, 5)).rejects.toThrow("limit");
		expect(cancel).toHaveBeenCalled();
	});
});
