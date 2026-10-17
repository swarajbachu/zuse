import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	access,
	chmod,
	mkdir,
	readdir,
	readFile,
	rename,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	ChatId,
	type SimulatorInput,
	type SimulatorPacket,
	type SimulatorPlatform,
	type SimulatorRequirement,
	type SimulatorState,
	SimulatorSummary,
	type SimulatorTarget,
} from "@zuse/contracts";
import { Schema } from "effect";
import {
	installNpmTool,
	isNpmToolInstalled,
} from "../process/npm-tool-installer.ts";
import { signalProcessGroup } from "../process/process-group.ts";
import { shellQuote as quote, simulatorLauncher } from "./launcher.ts";
import { discardOutput, runHelper, startHelper } from "./process.ts";
import {
	ANDROID_KEY_PACKET,
	ANDROID_RESET_PACKET,
	androidGesture,
	androidVideoPacket,
	readBounded,
	SimulatorPacketParser,
} from "./protocol.ts";

const MAX_QUEUED_FRAMES = 30;

import {
	type AndroidSdk,
	androidDisplayName,
	androidEnvironment,
	androidTool,
	installCmdlineTools,
	listAvdNames,
	resolveAndroidSdk,
} from "./android-sdk.ts";
import {
	ANDROID_CMDLINE_TOOLS,
	ANDROID_DEFAULT_AVD,
	SIMULATOR_TOOLS,
	supportedDeviceNode,
} from "./toolchain.ts";

const HubDevice = Schema.Struct({
	id: SimulatorSummary.fields.id,
	name: Schema.String,
	version: Schema.String,
	booted: Schema.Boolean,
	platform: Schema.String,
	physical: Schema.optional(Schema.Boolean),
	supported: Schema.optional(Schema.Boolean),
});
const HubDevices = Schema.Struct({
	simulators: Schema.Array(HubDevice),
	emulators: Schema.optional(Schema.Array(HubDevice)),
	errors: Schema.optional(
		Schema.Array(Schema.Struct({ message: Schema.String })),
	),
});
const HubAction = Schema.Struct({
	ok: Schema.Boolean,
	/** Android boots return the running emulator's serial. */
	id: Schema.optional(SimulatorSummary.fields.id),
	error: Schema.optional(Schema.String),
});
const Sessions = Schema.Array(
	Schema.Struct({
		chatId: ChatId,
		deviceId: SimulatorSummary.fields.id,
		openedAt: Schema.Number,
	}),
);
const Screen = Schema.Struct({
	width: Schema.Number,
	height: Schema.Number,
	orientation: Schema.String,
});
export interface SimulatorPreferences {
	enabled: boolean;
	agentAccessEnabled: boolean;
	onboardingCompleted: boolean;
}
export interface SimulatorControllerOptions {
	readonly root: string;
	readonly preferences: () => Promise<SimulatorPreferences>;
	readonly savePreferences: (value: SimulatorPreferences) => Promise<void>;
	readonly publish: (state: SimulatorState) => void;
	readonly filterSessions?: (
		sessions: SimulatorState["sessions"],
	) => Promise<SimulatorState["sessions"]>;
	readonly run?: typeof runHelper;
	readonly platform?: NodeJS.Platform;
	/** Host overrides for tests; default to this process. */
	readonly arch?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly home?: string;
}

/** One environment owns the helpers and sessions; viewers never own simulator power. */
export class SimulatorController {
	state: SimulatorState = {
		enabled: false,
		agentAccessEnabled: false,
		onboardingCompleted: false,
		status: "disabled",
		detail: "Device support is off.",
		requirements: [],
		agentStatus: "off",
		agentDetail: "",
		tools: {
			hub: SIMULATOR_TOOLS.hub.version,
			agent: SIMULATOR_TOOLS.agent.version,
		},
		devices: [],
		sessions: [],
		revision: 0,
	};
	private readonly owner = randomUUID();
	private hub: ChildProcess | undefined;
	private agents = new Map<string, ChildProcess>();
	private agentStarts = new Map<string, Promise<void>>();
	private origin: string | undefined;
	private starting: Promise<string> | undefined;
	private refreshJob: Promise<SimulatorState> | undefined;
	private lifetime = new AbortController();
	private activity = new AbortController();
	private agentActivity = new AbortController();
	private screens = new Map<
		string,
		{ config: typeof Screen.Type; unavailable: boolean }
	>();
	private inputSockets = new Map<string, Promise<WebSocket>>();
	private deviceJobs = new Map<string, Promise<unknown>>();
	private streams = new Map<string, Set<AbortController>>();
	private preferenceWrites: Promise<void> = Promise.resolve();
	/** Running one-click remedies, with their latest progress line. */
	private fixes = new Map<SimulatorRequirement["id"], string>();
	/** The Android SDK found by the latest inspection. */
	private android: AndroidSdk | null = null;
	private persistence: Promise<void> = Promise.resolve();
	private readonly run: typeof runHelper;
	constructor(private readonly options: SimulatorControllerOptions) {
		this.run = options.run ?? runHelper;
	}
	private get toolsRoot() {
		return join(this.options.root, "tools");
	}
	private get stateRoot() {
		return join(this.options.root, "simulators");
	}
	private emit(patch: Partial<SimulatorState>) {
		this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
		this.options.publish(this.state);
	}
	private async atomic(name: string, value: unknown) {
		await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
		const file = join(this.stateRoot, name),
			temporary = `${file}.${randomUUID()}.tmp`;
		await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
		await rename(temporary, file);
	}
	private persist() {
		const sessions = this.state.sessions;
		this.persistence = this.persistence
			.catch(() => {})
			.then(() => this.atomic("sessions.json", sessions));
		return this.persistence;
	}
	async initialize() {
		const prefs = await this.options.preferences();
		let sessions: typeof this.state.sessions = [];
		try {
			sessions = Schema.decodeUnknownSync(Schema.fromJsonString(Sessions))(
				await readFile(join(this.stateRoot, "sessions.json"), "utf8"),
			);
		} catch {
			/* Absent or obsolete viewer state never changes runtime data. */
		}
		if (this.options.filterSessions)
			sessions = await this.options.filterSessions(sessions);
		this.emit({
			...prefs,
			sessions,
			agentStatus:
				prefs.enabled &&
				prefs.agentAccessEnabled &&
				(await isNpmToolInstalled(this.toolsRoot, SIMULATOR_TOOLS.agent))
					? "ready"
					: "off",
			status: prefs.enabled ? "idle" : "disabled",
			detail: prefs.enabled
				? "Open the Simulator panel to start the device hub."
				: "Device support is off.",
		});
		await this.atomic("access.json", {
			enabled: prefs.enabled && prefs.agentAccessEnabled,
			owner: this.owner,
			pid: process.pid,
		});
		await this.persist();
		await this.atomic("agent-config.json", {});
	}
	async reconcile(prefs: SimulatorPreferences) {
		prefs = await this.options.preferences();
		this.emit({
			...prefs,
			...(!prefs.enabled
				? {
						status: "disabled" as const,
						detail: "Device support is off.",
						devices: [],
					}
				: {}),
		});

		if (!prefs.enabled) {
			this.activity.abort();
			this.activity = new AbortController();
			if (this.hub) signalProcessGroup(this.hub, "SIGKILL");
			this.hub = undefined;
			this.origin = undefined;
			for (const socket of this.inputSockets.values())
				void socket.then((ws) => ws.close()).catch(() => {});
			this.inputSockets.clear();
			this.screens.clear();
		}
		if (!prefs.enabled || !prefs.agentAccessEnabled) {
			this.emit({ agentStatus: "off", agentDetail: "" });
			this.agentActivity.abort();
			this.agentActivity = new AbortController();
			await this.atomic("access.json", { enabled: false });
			await this.stopAgent();
		}
		const current = await this.options.preferences();

		await this.atomic("access.json", {
			enabled: current.enabled && current.agentAccessEnabled,
			owner: this.owner,
			pid: process.pid,
		});
	}
	async configure(patch: Partial<SimulatorPreferences>) {
		const update = this.preferenceWrites
			.catch(() => {})
			.then(async () => {
				const current = await this.options.preferences();
				const next = { ...current, ...patch };
				if (!next.enabled) next.agentAccessEnabled = false;
				await this.options.savePreferences(next);
				await this.reconcile(next);
				return next;
			});
		this.preferenceWrites = update.then(() => {});
		const next = await update;

		if (next.enabled) await this.refresh();
		if (next.agentAccessEnabled) await this.agentEntry();
		return this.state;
	}
	private get platform() {
		return this.options.platform ?? process.platform;
	}
	private get env() {
		return this.options.env ?? process.env;
	}
	/** Read-only host inspection; never installs or starts anything. */
	async inspect(): Promise<SimulatorRequirement[]> {
		const probe = (file: string, args: string[]) =>
			this.run(file, args, this.options.root, this.lifetime.signal).catch(
				() => null,
			);
		const mac = this.platform === "darwin";
		const [npm, xcode, simctl, android, avds] = await Promise.all([
			probe("npm", ["--version"]),
			mac ? probe("xcode-select", ["-p"]) : null,
			mac
				? probe("xcrun", ["simctl", "list", "devices", "available", "--json"])
				: null,
			resolveAndroidSdk(this.env, this.platform, this.options.home),
			listAvdNames(this.env, this.options.home),
		]);
		this.android = android;
		const requirements: SimulatorRequirement[] = [];
		if (mac) {
			let simulators: number | null = null;
			try {
				const parsed: { devices?: Record<string, unknown> } = JSON.parse(
					simctl ?? "",
				);
				simulators = Object.entries(parsed.devices ?? {})
					.filter(([runtime]) => runtime.includes("iOS"))
					.reduce(
						(sum, [, list]) => sum + (Array.isArray(list) ? list.length : 0),
						0,
					);
			} catch {
				/* Unparseable output leaves the runtime count to the hub. */
			}
			const installedXcode = await this.installedXcode();
			requirements.push(
				{
					id: "xcode",
					platform: "ios",
					ok: xcode !== null && simctl !== null,
					detail:
						installedXcode === null
							? "Install Xcode from the App Store, then set it up here."
							: simctl === null
								? "Xcode is installed but not set up for command-line tools yet."
								: (xcode?.trim() ?? installedXcode),
					...(simctl !== null
						? {}
						: {
								fix: {
									label: installedXcode === null ? "Get Xcode" : "Set up",
									running: false,
								},
							}),
				},
				{
					id: "runtime",
					platform: "ios",
					ok: simctl !== null && simulators !== 0,
					detail:
						simctl === null
							? "Available after Xcode is set up."
							: simulators === 0
								? "Download the iOS simulator runtime (several GB)."
								: simulators === null
									? "Simulator runtime available"
									: plural(simulators, "iOS simulator"),
					...(simctl !== null && simulators === 0
						? { fix: { label: "Install", running: false } }
						: {}),
				},
			);
		}
		const sdkReady =
			android.root !== null &&
			android.adb &&
			android.emulator &&
			android.cmdlineTools;
		const canDownloadTools =
			ANDROID_CMDLINE_TOOLS.archives[`${this.platform}-${this.arch}`] !==
			undefined;
		const missing = [
			android.adb ? null : "Platform-Tools",
			android.emulator ? null : "the Android Emulator",
			android.cmdlineTools ? null : "Command-line Tools",
		].filter((item) => item !== null);
		const sdkFixable =
			android.root !== null &&
			(android.cmdlineTools || canDownloadTools) &&
			(android.licensed || (android.adb && android.emulator));
		requirements.push(
			{
				id: "android-sdk",
				platform: "android",
				ok: sdkReady,
				detail:
					android.root === null
						? "Install Android Studio, which includes the Android SDK."
						: sdkReady
							? android.root
							: `The Android SDK is missing ${missing.join(", ").replace(/, ([^,]*)$/u, " and $1")}.${
									sdkFixable
										? ""
										: " Accept the SDK license in Android Studio’s SDK Manager, then check again."
								}`,
				...(android.root === null
					? { fix: { label: "Get Android Studio", running: false } }
					: !sdkReady && sdkFixable
						? { fix: { label: "Install", running: false } }
						: {}),
			},
			{
				id: "android-avd",
				platform: "android",
				ok: sdkReady && avds.length > 0,
				detail: !sdkReady
					? "Available after the Android SDK is set up."
					: avds.length > 0
						? plural(avds.length, "emulator")
						: "Create an emulator. Downloads a system image of about 2 GB.",
				...(sdkReady && avds.length === 0
					? { fix: { label: "Create", running: false } }
					: {}),
			},
		);
		const node = supportedDeviceNode(process.versions.node);
		requirements.push({
			id: "node",
			platform: "all",
			ok: node && npm !== null,
			detail: !node
				? "Device tools require Node 22.12 or newer."
				: npm === null
					? "npm is unavailable. Install Node, then restart Zuse."
					: `Node ${process.versions.node.replace(/^v/, "")}`,
			...(node && npm === null
				? { fix: { label: "Get Node", running: false } }
				: {}),
		});
		return this.withFixProgress(requirements);
	}
	private get arch() {
		return this.options.arch ?? process.arch;
	}
	private withFixProgress(requirements: SimulatorRequirement[]) {
		return requirements.map((item) => {
			const progress = this.fixes.get(item.id);
			return progress === undefined || !item.fix
				? item
				: { ...item, detail: progress, fix: { ...item.fix, running: true } };
		});
	}
	private async installedXcode() {
		for (const app of [
			"/Applications/Xcode.app",
			"/Applications/Xcode-beta.app",
		])
			if (
				await access(app).then(
					() => true,
					() => false,
				)
			)
				return app;
		return null;
	}
	private emitFixProgress(id: SimulatorRequirement["id"], detail: string) {
		this.fixes.set(id, detail);
		this.emit({
			requirements: this.withFixProgress([...this.state.requirements]),
		});
	}
	private openOnHost(url: string) {
		const [file, args] =
			this.platform === "darwin"
				? ["open", [url]]
				: this.platform === "win32"
					? ["cmd", ["/c", "start", "", url]]
					: ["xdg-open", [url]];
		return this.run(file, args, this.options.root, this.lifetime.signal);
	}
	/**
	 * Performs a requirement's one-click remedy on the host. Store and download
	 * pages open on the host; Xcode setup asks for an administrator password
	 * through macOS; runtimes, SDK packages and emulator images download with
	 * live progress. Licenses are never accepted on the user's behalf.
	 */
	async fix(id: SimulatorRequirement["id"]) {
		if (this.fixes.has(id)) return this.state;
		const current = (await this.inspect()).find((item) => item.id === id);
		if (!current?.fix) {
			this.emit({ requirements: await this.inspect() });
			return this.state;
		}
		const signal = this.lifetime.signal;
		const run = (
			file: string,
			args: string[],
			timeout = 60000,
			onOutput?: (chunk: string) => void,
			env?: NodeJS.ProcessEnv,
		) =>
			this.run(file, args, this.options.root, signal, timeout, env, onOutput);
		const progress = (chunk: string) => {
			const line = progressLine(chunk);
			if (line) this.emitFixProgress(id, line);
		};
		/** sdkmanager draws ASCII bars; show a plain label with its percentage. */
		const labeled = (label: string) => (chunk: string) => {
			const percent = progressLine(chunk)?.match(/(\d+)(?:\.\d+)?%/u)?.[1];
			if (percent !== undefined)
				this.emitFixProgress(id, `${label} ${percent}%`);
		};
		try {
			if (id === "xcode") {
				const app = await this.installedXcode();
				if (app === null) {
					await this.openOnHost("macappstore://apps.apple.com/app/id497799835");
				} else {
					this.emitFixProgress(id, "Waiting for your administrator password…");
					const developer = `${app}/Contents/Developer`;
					// One native prompt selects Xcode, accepts its license and installs
					// its first-launch components.
					await run(
						"osascript",
						[
							"-e",
							`do shell script "xcode-select -s ${developer} && xcodebuild -license accept && xcodebuild -runFirstLaunch" with administrator privileges`,
						],
						30 * 60000,
					);
				}
			} else if (id === "runtime") {
				this.emitFixProgress(id, "Starting download…");
				await run(
					"xcodebuild",
					["-downloadPlatform", "iOS"],
					3 * 60 * 60000,
					progress,
				);
			} else if (id === "node") {
				await this.openOnHost("https://nodejs.org/en/download");
			} else if (id === "android-sdk") {
				const sdk = this.android;
				if (!sdk?.root) {
					await this.openOnHost("https://developer.android.com/studio");
				} else {
					if (!sdk.cmdlineTools) {
						const archive =
							ANDROID_CMDLINE_TOOLS.archives[`${this.platform}-${this.arch}`];
						if (!archive)
							throw new Error("No Command-line Tools download for this host");
						this.emitFixProgress(id, "Downloading Command-line Tools…");
						await installCmdlineTools({
							root: sdk.root,
							url: ANDROID_CMDLINE_TOOLS.base + archive.file,
							sha1: archive.sha1,
							signal,
							unzip: (zip, into) =>
								run("unzip", ["-q", "-o", zip, "-d", into], 10 * 60000),
							onProgress: (percent) =>
								this.emitFixProgress(
									id,
									`Downloading Command-line Tools… ${percent}%`,
								),
						});
					}
					if (!sdk.adb || !sdk.emulator) {
						if (!sdk.licensed)
							throw new Error(
								"accept the Android SDK license in Android Studio’s SDK Manager first",
							);
						this.emitFixProgress(id, "Installing Platform-Tools and Emulator…");
						await run(
							androidTool(sdk.root, "sdkmanager", this.platform),
							["--install", "platform-tools", "emulator"],
							60 * 60000,
							labeled("Installing Platform-Tools and Emulator…"),
							androidEnvironment(sdk, this.env),
						);
					}
					// The hub inherits the SDK location when it starts.
					this.restartHub();
				}
			} else if (id === "android-avd") {
				const sdk = this.android;
				if (!sdk?.root) throw new Error("the Android SDK is not set up");
				const image = ANDROID_DEFAULT_AVD.image(this.arch);
				const env = androidEnvironment(sdk, this.env);
				this.emitFixProgress(id, "Downloading the system image…");
				await run(
					androidTool(sdk.root, "sdkmanager", this.platform),
					["--install", image],
					2 * 60 * 60000,
					labeled("Downloading the system image…"),
					env,
				);
				this.emitFixProgress(id, "Creating the emulator…");
				await run(
					androidTool(sdk.root, "avdmanager", this.platform),
					[
						"create",
						"avd",
						"--name",
						ANDROID_DEFAULT_AVD.name,
						"--package",
						image,
						"--device",
						ANDROID_DEFAULT_AVD.device,
					],
					5 * 60000,
					undefined,
					env,
				);
			}
		} catch (cause) {
			this.fixes.delete(id);
			this.emit({ requirements: await this.inspect() });
			const reason = errorMessage(cause);
			throw new Error(
				id === "xcode"
					? `Xcode setup didn’t finish: ${reason}`
					: id === "runtime"
						? `The iOS runtime download failed: ${reason}`
						: id === "android-sdk"
							? `Android SDK setup didn’t finish: ${reason}`
							: id === "android-avd"
								? `Creating the emulator failed: ${reason}. If a license is missing, run \`sdkmanager --licenses\` and try again.`
								: reason,
			);
		}
		this.fixes.delete(id);
		const requirements = await this.inspect();
		this.emit({ requirements });
		if (this.state.enabled && id !== "node")
			await this.refresh().catch(() => {});
		return this.state;
	}
	/** Throws when no platform can run; a missing runtime or emulator is not blocking. */
	async check() {
		const requirements = await this.inspect();
		this.emit({ requirements });
		const node = requirements.find((item) => item.id === "node");
		if (node && !node.ok) throw new Error(node.detail);
		const ready = (id: SimulatorRequirement["id"]) =>
			requirements.some((item) => item.id === id && item.ok);
		if (!ready("xcode") && !ready("android-sdk"))
			throw new Error(
				this.platform === "darwin"
					? "Set up Xcode for iOS simulators or the Android SDK for emulators."
					: "Install the Android SDK to use emulators. iOS simulators need a Mac with Xcode.",
			);
	}
	/** Native helpers find adb and the emulator through the resolved SDK. */
	private helperEnvironment(base: NodeJS.ProcessEnv = this.env) {
		const env = this.android
			? androidEnvironment(this.android, base)
			: { ...base };
		const uid = process.getuid?.();
		// Emulators publish their gRPC token under XDG_RUNTIME_DIR on Linux.
		if (this.platform === "linux" && !env.XDG_RUNTIME_DIR && uid !== undefined)
			env.XDG_RUNTIME_DIR = `/run/user/${uid}`;
		return env;
	}
	/** Stops the hub so the next use restarts it with the current SDK environment. */
	private restartHub() {
		if (!this.hub) return;
		const hub = this.hub;
		this.hub = undefined;
		this.origin = undefined;
		signalProcessGroup(hub, "SIGKILL");
	}
	async requireAccess(agent = false) {
		const prefs = await this.options.preferences();
		if (!prefs.enabled || (agent && !prefs.agentAccessEnabled))
			throw new Error(
				agent
					? "Agent device access is off. Turn it on in the Simulator panel."
					: "Device support is off. Turn it on in the Simulator panel.",
			);
	}
	private async ready(): Promise<string> {
		await this.requireAccess();
		if (this.origin && this.hub?.exitCode === null && !this.hub.killed)
			return this.origin;
		if (this.starting) return this.starting;
		const activity = AbortSignal.any([
			this.activity.signal,
			this.lifetime.signal,
		]);
		this.starting = (async () => {
			this.emit({
				status: "checking",
				detail: "Checking device tools…",
			});
			await this.check();
			activity.throwIfAborted();
			this.emit({
				status: "installing",
				detail: `Installing device hub ${SIMULATOR_TOOLS.hub.version}…`,
			});
			const entry = await installNpmTool(
				this.toolsRoot,
				SIMULATOR_TOOLS.hub,
				(args) => this.run("npm", args, this.options.root, activity, 600000),
			);
			activity.throwIfAborted();
			this.emit({ status: "starting", detail: "Starting device hub…" });
			const port = await new Promise<number>((resolve, reject) => {
				const listener = createServer();
				listener.once("error", reject);
				listener.listen(0, "127.0.0.1", () => {
					const address = listener.address();
					if (!address || typeof address === "string") {
						listener.close();
						reject(new Error("Could not reserve device port"));
						return;
					}
					listener.close((error) =>
						error ? reject(error) : resolve(address.port),
					);
				});
			});
			const origin = `http://127.0.0.1:${port}`;
			const child = startHelper(
				process.execPath,
				[
					entry,
					"--host",
					"127.0.0.1",
					"--port",
					String(port),
					"--hide-sidebar",
					"--hide-boot-device",
				],
				this.options.root,
				activity,
				() => {
					if (this.hub !== child) return;
					this.hub = undefined;
					this.origin = undefined;
					if (!activity.aborted)
						this.emit({
							status: "error",
							detail: "Device hub stopped. Refresh to reconnect.",
						});
				},
				this.helperEnvironment(),
			);
			this.hub = child;
			discardOutput(child);
			try {
				const deadline = Date.now() + 30000;
				while (Date.now() < deadline) {
					activity.throwIfAborted();
					if (child.exitCode !== null)
						throw new Error("Device hub exited during startup.");
					const response = await fetch(`${origin}/api/devices`, {
						signal: AbortSignal.any([activity, AbortSignal.timeout(2000)]),
					}).catch(() => null);
					if (response?.ok) {
						await response.body?.cancel();
						this.origin = origin;
						return origin;
					}
					await response?.body?.cancel();
					await delay(200, undefined, { signal: activity });
				}
				throw new Error("Device hub startup timed out. Refresh to retry.");
			} catch (cause) {
				signalProcessGroup(child, "SIGKILL");
				throw cause;
			}
		})().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}
	private async request(path: string, body?: unknown) {
		const origin = await this.ready();
		const response = await fetch(`${origin}${path}`, {
			method: body === undefined ? "GET" : "POST",
			...(body === undefined
				? {}
				: {
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					}),
			signal: AbortSignal.any([
				this.activity.signal,
				this.lifetime.signal,
				// Cold emulator boots can take up to the hub's three-minute limit.
				AbortSignal.timeout(240000),
			]),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Device hub request failed (${response.status}).`);
		}
		return response;
	}
	private async hubAction(path: string, body: unknown) {
		return Schema.decodeUnknownSync(HubAction)(
			await (await this.request(path, body)).json(),
		);
	}
	async refresh() {
		if (this.refreshJob) return this.refreshJob;
		this.refreshJob = (async () => {
			const prefs = await this.options.preferences();
			if (!prefs.enabled) {
				try {
					await this.check();
					this.emit({
						detail:
							"Device tools are ready. Turn on simulators to list devices.",
					});
				} catch (cause) {
					this.emit({ detail: errorMessage(cause) });
				}
				return this.state;
			}
			try {
				const result = Schema.decodeUnknownSync(HubDevices)(
					await (await this.request("/api/devices")).json(),
				);
				await this.requireAccess();
				if (this.options.filterSessions) {
					const snapshot = this.state.sessions;
					const retained = await this.options.filterSessions(snapshot);
					for (const session of snapshot) {
						if (
							!retained.some(
								(item) =>
									item.chatId === session.chatId &&
									item.deviceId === session.deviceId,
							)
						)
							await this.close(session, false, false, session.openedAt);
					}
				}
				const devices = await this.listDevices(result);
				this.emit({
					status: "ready",
					devices,
					detail:
						result.errors?.map((error) => error.message).join("\n") ||
						(devices.length
							? "Devices are ready."
							: "No simulators or emulators found."),
				});
			} catch (cause) {
				if (this.state.enabled)
					this.emit({
						status:
							(this.options.platform ?? process.platform) === "darwin"
								? "error"
								: "unavailable",
						detail: errorMessage(cause),
					});
				throw cause;
			}
			return this.state;
		})().finally(() => {
			this.refreshJob = undefined;
		});
		return this.refreshJob;
	}
	/**
	 * iOS simulators and Android emulators from the hub, plus AVDs the hub
	 * omits because they have never booted. Physical devices are excluded.
	 */
	private async listDevices(
		result: typeof HubDevices.Type,
	): Promise<SimulatorSummary[]> {
		const devices: SimulatorSummary[] = [];
		for (const device of [...result.simulators, ...(result.emulators ?? [])]) {
			if (device.physical || device.supported === false) continue;
			if (device.platform === "ios")
				devices.push({ ...pick(device), platform: "ios" });
			else if (device.platform === "android")
				devices.push({
					...pick(device),
					platform: "android",
					name: androidDisplayName(device.name),
				});
		}
		if (this.android?.root)
			for (const name of await listAvdNames(this.env, this.options.home))
				if (!(result.emulators ?? []).some((device) => device.name === name))
					devices.push({
						id: name,
						platform: "android",
						name: androidDisplayName(name),
						version: "Android",
						booted: false,
					});
		return devices;
	}
	private platformOf(deviceId: string): SimulatorPlatform {
		return (
			this.state.devices.find((device) => device.id === deviceId)?.platform ??
			(/^emulator-\d+$/u.test(deviceId) ? "android" : "ios")
		);
	}
	private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
		const prior = this.deviceJobs.get(id) ?? Promise.resolve();
		const job = prior
			.catch(() => {})
			.then(work)
			.finally(() => {
				if (this.deviceJobs.get(id) === job) this.deviceJobs.delete(id);
			});
		this.deviceJobs.set(id, job);
		return job;
	}
	async open(target: SimulatorTarget, agent = false) {
		await this.requireAccess(agent);
		await this.refresh();
		return this.serial(target.deviceId, async () => {
			await this.requireAccess(agent);
			const device = this.state.devices.find(
				(device) => device.id === target.deviceId,
			);
			if (!device)
				throw new Error(
					"Simulator not found. Refresh devices and choose an available simulator.",
				);
			if (
				this.state.sessions.some(
					(session) =>
						session.deviceId === target.deviceId &&
						session.chatId !== target.chatId,
				)
			)
				throw new Error(
					"This simulator is already owned by another chat. Close it there or choose another simulator.",
				);
			// The grid start boots an iOS simulator and attaches its capture
			// helper. Android boots by AVD name and comes up under a new serial,
			// which becomes the device's id for the session.
			const result =
				device.platform === "ios"
					? await this.hubAction("/vendor/serve-sim/grid/api/start", {
							udid: device.id,
						})
					: device.booted
						? { ok: true, id: device.id }
						: await this.hubAction("/api/devices/boot", {
								platform: "android",
								id: device.id,
								name: device.id,
							});
			if (!result.ok)
				throw new Error(
					result.error ??
						(device.platform === "ios"
							? "Could not start the simulator"
							: "Could not start the emulator"),
				);
			await this.requireAccess(agent);
			const summary = { ...device, id: result.id ?? device.id, booted: true };
			const opened = { ...target, deviceId: summary.id };
			const priorOpenedAt =
				this.state.sessions.find(
					(session) =>
						session.chatId === opened.chatId &&
						session.deviceId === opened.deviceId,
				)?.openedAt ?? 0;
			this.emit({
				devices: this.state.devices.map((item) =>
					item.id === device.id ? summary : item,
				),
				sessions: [
					...this.state.sessions.filter(
						(session) =>
							session.chatId !== opened.chatId ||
							session.deviceId !== opened.deviceId,
					),
					{ ...opened, openedAt: Math.max(Date.now(), priorOpenedAt + 1) },
				],
			});
			await this.persist();
			return summary;
		});
	}
	async assertSession(target: SimulatorTarget, agent = false) {
		await this.requireAccess(agent);
		if (
			!this.state.sessions.some(
				(session) =>
					session.chatId === target.chatId &&
					session.deviceId === target.deviceId,
			)
		)
			throw new Error("Open this simulator in the current chat first.");
	}
	async close(
		target: SimulatorTarget,
		shutdown = false,
		agent = false,
		expectedOpenedAt?: number,
	) {
		return this.serial(target.deviceId, async () => {
			if (
				expectedOpenedAt !== undefined &&
				!this.state.sessions.some(
					(session) =>
						session.chatId === target.chatId &&
						session.deviceId === target.deviceId &&
						session.openedAt === expectedOpenedAt,
				)
			)
				return;
			await this.assertSession(target, agent);
			if (shutdown) {
				const result =
					this.platformOf(target.deviceId) === "ios"
						? await this.hubAction("/vendor/serve-sim/grid/api/shutdown", {
								udid: target.deviceId,
							})
						: await this.hubAction("/api/devices/shutdown", {
								platform: "android",
								id: target.deviceId,
								name: target.deviceId,
							});
				if (!result.ok)
					throw new Error(result.error ?? "Could not shut down the device");
			}
			for (const stream of this.streams.get(target.deviceId) ?? [])
				stream.abort();
			await this.stopAgent(target);
			this.emit({
				...(shutdown
					? {
							devices: this.state.devices.map((device) =>
								device.id === target.deviceId
									? { ...device, booted: false }
									: device,
							),
						}
					: {}),
				sessions: this.state.sessions.filter(
					(session) =>
						session.chatId !== target.chatId ||
						session.deviceId !== target.deviceId,
				),
			});
			await this.persist();
			const socket = this.inputSockets.get(target.deviceId);
			this.inputSockets.delete(target.deviceId);
			void socket?.then((ws) => ws.close()).catch(() => {});
		});
	}
	async screenshot(target: SimulatorTarget, agent = false) {
		await this.assertSession(target, agent);
		const response = await this.request(
			`${vendor(this.platformOf(target.deviceId))}/api/screenshot?device=${encodeURIComponent(target.deviceId)}`,
			{},
		);
		const data = await readBounded(response, 8 * 1024 * 1024);
		await this.assertSession(target, agent);
		return data.toString("base64");
	}
	async *frames(
		target: SimulatorTarget,
		format: "avcc" | "mjpeg",
		signal: AbortSignal,
	): AsyncGenerator<SimulatorPacket> {
		await this.assertSession(target);
		const origin = await this.ready();
		const stream = new AbortController();
		const streams =
			this.streams.get(target.deviceId) ?? new Set<AbortController>();
		streams.add(stream);
		this.streams.set(target.deviceId, streams);
		try {
			const combined = AbortSignal.any([
				stream.signal,
				signal,
				this.activity.signal,
				this.lifetime.signal,
			]);
			if (this.platformOf(target.deviceId) === "android") {
				if (format !== "avcc")
					throw new Error(
						"Android video needs WebCodecs, which this window doesn’t support.",
					);
				yield* this.androidFrames(target, origin, combined);
				return;
			}
			const prefix = `/vendor/serve-sim/helper/${encodeURIComponent(target.deviceId)}`;
			// Capture must be active before HID/config or AVCC reliably becomes available.
			if (format === "avcc") {
				const prime = new AbortController();
				try {
					const response = await fetch(`${origin}${prefix}/stream.mjpeg`, {
						signal: AbortSignal.any([
							combined,
							prime.signal,
							AbortSignal.timeout(2000),
						]),
					});
					const reader = response.body?.getReader();
					await reader?.read();
					await reader?.cancel();
				} catch {
					/* AVCC connection reports the actionable failure. */
				} finally {
					prime.abort();
				}
			}
			const config = Schema.decodeUnknownSync(Screen)(
				await (
					await fetch(`${origin}${prefix}/config`, {
						signal: AbortSignal.any([combined, AbortSignal.timeout(5000)]),
					})
				).json(),
			);
			yield {
				tag: 130,
				data: Buffer.from(JSON.stringify(config)).toString("base64"),
			};
			const response = await fetch(`${origin}${prefix}/stream.${format}`, {
				signal: combined,
			});
			if (!response.ok || !response.body)
				throw new Error(
					"Simulator stream is unavailable. Refresh to reconnect.",
				);
			const reader = response.body.getReader();
			const parser = new SimulatorPacketParser(format);
			let screenJson = JSON.stringify(config);
			try {
				while (true) {
					await this.assertSession(target);
					const next = await reader.read();
					if (next.done) throw new Error("Simulator stream ended");
					const screen = this.screens.get(target.deviceId);
					if (screen && JSON.stringify(screen.config) !== screenJson) {
						screenJson = JSON.stringify(screen.config);
						yield {
							tag: 130,
							data: Buffer.from(screenJson).toString("base64"),
						};
					}
					for (const packet of parser.push(next.value)) yield packet;
				}
			} finally {
				await reader.cancel().catch(() => {});
				reader.releaseLock();
			}
		} finally {
			stream.abort();
			streams.delete(stream);
			if (!streams.size) this.streams.delete(target.deviceId);
		}
	}
	/**
	 * One serve-emu socket per viewer. Frames queue boundedly: when a viewer
	 * falls behind, the backlog is dropped and the encoder asked for a fresh
	 * keyframe, so latency stays low instead of growing.
	 */
	private async *androidFrames(
		target: SimulatorTarget,
		origin: string,
		signal: AbortSignal,
	): AsyncGenerator<SimulatorPacket> {
		const ws = new WebSocket(
			`${origin.replace("http:", "ws:")}/vendor/serve-emu/ws?device=${encodeURIComponent(target.deviceId)}&frame-meta=1`,
		);
		ws.binaryType = "arraybuffer";
		const queue: SimulatorPacket[] = [];
		let wake: (() => void) | undefined;
		let failure: Error | undefined;
		const notify = () => {
			wake?.();
			wake = undefined;
		};
		const requestKeyframe = () => {
			if (ws.readyState === WebSocket.OPEN)
				ws.send(JSON.stringify({ type: "reset-video", ack: false }));
		};
		ws.addEventListener("open", requestKeyframe, { once: true });
		ws.addEventListener("message", (event) => {
			try {
				const packet = androidVideoPacket(
					typeof event.data === "string"
						? event.data
						: Buffer.from(event.data as ArrayBuffer),
				);
				if (!packet) return;
				if (packet.tag === ANDROID_RESET_PACKET) {
					queue.length = 0;
					requestKeyframe();
				} else if (queue.length >= MAX_QUEUED_FRAMES) {
					queue.length = 0;
					queue.push({ tag: ANDROID_RESET_PACKET, data: "" });
					requestKeyframe();
					if (packet.tag !== ANDROID_KEY_PACKET) return notify();
				}
				queue.push(packet);
				notify();
			} catch (cause) {
				failure = cause instanceof Error ? cause : new Error(String(cause));
				ws.close();
			}
		});
		ws.addEventListener("close", (event) => {
			failure ??= new Error(
				event.code === 1013
					? "The emulator is still starting. Reconnect in a moment."
					: "Emulator stream ended. Reconnect to try again.",
			);
			notify();
		});
		const abort = () => ws.close();
		signal.addEventListener("abort", abort, { once: true });
		try {
			while (true) {
				signal.throwIfAborted();
				const next = queue.shift();
				if (next) {
					await this.assertSession(target);
					yield next;
					continue;
				}
				if (failure) throw failure;
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			}
		} finally {
			signal.removeEventListener("abort", abort);
			ws.close();
		}
	}
	async input(target: SimulatorTarget, input: SimulatorInput) {
		if (this.platformOf(target.deviceId) === "android")
			return this.androidInput(target, input);
		await this.assertSession(target);
		let socket = this.inputSockets.get(target.deviceId);
		if (!socket) {
			socket = (async () => {
				const origin = await this.ready();
				const ws = new WebSocket(
					`${origin.replace("http:", "ws:")}/vendor/serve-sim/helper/ws?device=${encodeURIComponent(target.deviceId)}`,
				);
				ws.binaryType = "arraybuffer";
				ws.addEventListener("message", (event) => {
					if (
						this.inputSockets.get(target.deviceId) !== socket ||
						!(event.data instanceof ArrayBuffer)
					)
						return;
					const bytes = new Uint8Array(event.data);
					if (bytes[0] === 131) {
						const screen = this.screens.get(target.deviceId);
						if (screen) screen.unavailable = false;
						return;
					}
					if (bytes[0] !== 130 || bytes.length > 65536) return;
					try {
						const payload: unknown = JSON.parse(
							new TextDecoder().decode(bytes.subarray(1)),
						);
						const config = Schema.decodeUnknownSync(Screen)(payload);
						const unavailable =
							typeof payload === "object" &&
							payload !== null &&
							"inputUnavailable" in payload &&
							payload.inputUnavailable === true;
						this.screens.set(target.deviceId, { config, unavailable });
					} catch {
						/* Ignore invalid native metadata without disrupting the input connection. */
					}
				});
				await new Promise<void>((resolve, reject) => {
					const finish = () => {
						clearTimeout(timer);
						resolve();
					};
					const timer = setTimeout(() => {
						ws.close();
						reject(new Error("Simulator input connection timed out"));
					}, 15000);
					ws.addEventListener("message", (event) => {
						if (
							event.data instanceof ArrayBuffer &&
							new Uint8Array(event.data)[0] === 131
						)
							finish();
					});
					ws.addEventListener(
						"open",
						() => {
							ws.send(
								Buffer.concat([
									Buffer.from([13]),
									Buffer.from(JSON.stringify({ enabled: false })),
								]),
							);
						},
						{ once: true },
					);
					ws.addEventListener(
						"error",
						() => {
							clearTimeout(timer);
							ws.close();
							reject(new Error("Simulator input is unavailable"));
						},
						{ once: true },
					);
					ws.addEventListener(
						"close",
						() => {
							clearTimeout(timer);
							reject(new Error("Simulator input connection closed"));
						},
						{ once: true },
					);
				});
				ws.addEventListener("close", () => {
					if (this.inputSockets.get(target.deviceId) === socket)
						this.inputSockets.delete(target.deviceId);
				});
				return ws;
			})();
			this.inputSockets.set(target.deviceId, socket);
			void socket.catch(() => {
				if (this.inputSockets.get(target.deviceId) === socket)
					this.inputSockets.delete(target.deviceId);
			});
		}
		const ws = await socket;
		await this.assertSession(target);
		if (this.screens.get(target.deviceId)?.unavailable)
			throw new Error("Simulator input is unavailable. Reconnect the device.");
		if (
			input._tag === "text" ||
			input._tag === "keycode" ||
			(input._tag === "button" && input.button === "back")
		)
			return;
		const tag =
			input._tag === "touch"
				? 3
				: input._tag === "key"
					? 6
					: input._tag === "rotate"
						? 7
						: 4;
		const payload =
			input._tag === "touch"
				? { type: input.phase, x: input.x, y: input.y }
				: input._tag === "key"
					? { type: input.phase, usage: input.usage }
					: input._tag === "rotate"
						? { orientation: input.orientation }
						: { button: input.button };
		if (ws.readyState !== WebSocket.OPEN)
			throw new Error(
				"Simulator input connection is closed. Retry after reconnecting.",
			);
		ws.send(
			Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(payload))]),
		);
	}
	/** Gestures go over an input-only serve-emu socket shared by the device's viewers. */
	private async androidInput(target: SimulatorTarget, input: SimulatorInput) {
		await this.assertSession(target);
		const gesture = androidGesture(input);
		if (!gesture) return;
		let socket = this.inputSockets.get(target.deviceId);
		if (!socket) {
			socket = (async () => {
				const origin = await this.ready();
				const ws = new WebSocket(
					`${origin.replace("http:", "ws:")}/vendor/serve-emu/ws?device=${encodeURIComponent(target.deviceId)}&video=0`,
				);
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => {
						ws.close();
						reject(new Error("Emulator input connection timed out"));
					}, 15000);
					ws.addEventListener(
						"open",
						() => {
							clearTimeout(timer);
							resolve();
						},
						{ once: true },
					);
					ws.addEventListener(
						"close",
						() => {
							clearTimeout(timer);
							reject(new Error("Emulator input is unavailable"));
						},
						{ once: true },
					);
				});
				ws.addEventListener("close", () => {
					if (this.inputSockets.get(target.deviceId) === socket)
						this.inputSockets.delete(target.deviceId);
				});
				return ws;
			})();
			this.inputSockets.set(target.deviceId, socket);
			void socket.catch(() => {
				if (this.inputSockets.get(target.deviceId) === socket)
					this.inputSockets.delete(target.deviceId);
			});
		}
		const ws = await socket;
		await this.assertSession(target);
		if (ws.readyState !== WebSocket.OPEN)
			throw new Error(
				"Emulator input connection is closed. Retry after reconnecting.",
			);
		ws.send(JSON.stringify(gesture));
	}
	async agentEntry() {
		await this.requireAccess(true);
		if (!(await isNpmToolInstalled(this.toolsRoot, SIMULATOR_TOOLS.agent)))
			this.emit({
				agentStatus: "installing",
				agentDetail: `Installing agent tools ${SIMULATOR_TOOLS.agent.version}…`,
			});
		let entry: string;
		try {
			entry = await installNpmTool(
				this.toolsRoot,
				SIMULATOR_TOOLS.agent,
				(args) =>
					this.run(
						"npm",
						args,
						this.options.root,
						AbortSignal.any([this.agentActivity.signal, this.lifetime.signal]),
						600000,
					),
			);
		} catch (cause) {
			if (this.state.enabled && this.state.agentAccessEnabled)
				this.emit({
					agentStatus: "error",
					agentDetail: `Agent tool setup failed: ${errorMessage(cause)}`,
				});
			throw cause;
		}
		await this.requireAccess(true);
		if (this.state.agentStatus !== "ready")
			this.emit({
				agentStatus: "ready",
				agentDetail:
					"On iOS, the first agent interaction prepares an XCTest runner, which can take a few minutes.",
			});
		return entry;
	}
	async agentTarget(target: SimulatorTarget) {
		await this.assertSession(target, true);
		const entry = await this.agentEntry();
		const session = targetSession(target);
		await this.startAgent(target, entry);
		await this.assertSession(target, true);
		const launcher = join(this.stateRoot, `agent-device-${session}`);
		const source = simulatorLauncher({
			node: process.execPath,
			entry,
			root: this.stateRoot,
			owner: this.owner,
			session,
			target,
			platform: this.platformOf(target.deviceId),
		});
		await writeFile(launcher, source, { mode: 0o700 });
		await chmod(launcher, 0o700);
		return {
			command: launcher,
			quickStart:
				this.platformOf(target.deviceId) === "android"
					? `The user can watch ${target.deviceId} in the Simulator panel. Use this exact launcher: ${quote(launcher)}. Its device and session are fixed. Typical loop: open <package>; snapshot -i; click @e3; fill @e5 "text"; screenshot /tmp/shot.png. Prefer snapshot references over coordinates. Use help for version-matched commands. Install a debug APK with adb -s ${target.deviceId} install -r <apk>; the emulator reaches the host as 10.0.2.2. Device access is separate from shell execution permissions.`
					: `The user can watch ${target.deviceId} in the Simulator panel. Use this exact launcher: ${quote(launcher)}. Its device and session are fixed. Typical loop: open <bundle-id>; snapshot -i; click @e3; fill @e5 "text"; screenshot /tmp/shot.png. Prefer snapshot references over coordinates. Use help for version-matched commands. First iOS interaction builds an XCTest runner and can take minutes. Build and install a simulator .app on this Mac; remote Metro needs a reachable address. Device access is separate from shell execution permissions.`,
		};
	}
	/** The pinned daemon entry runs in our existing lease supervisor, including XCTest descendants. */
	private async startAgent(target: SimulatorTarget, entry: string) {
		const session = targetSession(target);
		const starting = this.agentStarts.get(session);
		if (starting) return starting;
		const existing = this.agents.get(session);
		if (existing && existing.exitCode === null && !existing.killed) return;
		const signal = AbortSignal.any([
			this.agentActivity.signal,
			this.lifetime.signal,
		]);
		const job = (async () => {
			await this.stopAgent(target);
			signal.throwIfAborted();
			const root = join(this.stateRoot, "agent-device", session);
			const env = this.helperEnvironment(cleanAgentEnvironment());
			env.AGENT_DEVICE_STATE_DIR = root;
			env.AGENT_DEVICE_CONFIG = join(this.stateRoot, "agent-config.json");
			env.AGENT_DEVICE_DAEMON_SERVER_MODE = "http";
			env.AGENT_DEVICE_IOS_RUNNER_DETACH = "false";
			env.AGENT_DEVICE_NO_UPDATE_NOTIFIER = "1";
			const child = startHelper(
				process.execPath,
				[join(dirname(entry), "..", "dist", "src", "internal", "daemon.js")],
				this.options.root,
				signal,
				() => {
					if (this.agents.get(session) === child) this.agents.delete(session);
				},
				env,
			);
			this.agents.set(session, child);
			discardOutput(child);
			try {
				const deadline = Date.now() + 30000;
				while (Date.now() < deadline) {
					signal.throwIfAborted();
					if (child.exitCode !== null || child.killed)
						throw new Error("Agent device helper exited during startup.");
					const registration: unknown = await readFile(
						join(root, "daemon.json"),
						"utf8",
					)
						.then(JSON.parse)
						.catch(() => null);
					if (
						typeof registration === "object" &&
						registration !== null &&
						"pid" in registration &&
						typeof registration.pid === "number" &&
						"httpPort" in registration &&
						typeof registration.httpPort === "number"
					)
						return;
					await delay(100, undefined, { signal });
				}
				throw new Error(
					"Agent device helper startup timed out. Reopen the device to retry.",
				);
			} catch (cause) {
				signalProcessGroup(child, "SIGKILL");
				throw cause;
			}
		})().finally(() => this.agentStarts.delete(session));
		this.agentStarts.set(session, job);
		return job;
	}

	private async stopAgent(target?: SimulatorTarget) {
		for (const [session, child] of this.agents) {
			if (target && session !== targetSession(target)) continue;
			signalProcessGroup(child, "SIGKILL");
			this.agents.delete(session);
		}
		if (!(await isNpmToolInstalled(this.toolsRoot, SIMULATOR_TOOLS.agent)))
			return;
		const entry = join(
			this.toolsRoot,
			SIMULATOR_TOOLS.agent.name,
			SIMULATOR_TOOLS.agent.version,
			"node_modules",
			SIMULATOR_TOOLS.agent.name,
			...SIMULATOR_TOOLS.agent.entry,
		);

		const root = join(this.stateRoot, "agent-device");
		const sessions = target
			? [targetSession(target)]
			: await readdir(root).catch(() => []);
		await Promise.all(
			sessions
				.filter((name) => /^[a-f0-9]{24}$/u.test(name))
				.map((session) =>
					this.run(
						process.execPath,
						[
							entry,
							"daemon",
							"stop",
							"--config",
							join(this.stateRoot, "agent-config.json"),
							"--state-dir",
							join(root, session),
						],
						this.options.root,
						this.lifetime.signal,
						15000,
						cleanAgentEnvironment(),
					).catch(() => {}),
				),
		);
	}
	async dispose() {
		await this.atomic("access.json", { enabled: false }).catch(() => {});
		await this.stopAgent();
		this.lifetime.abort();
		this.activity.abort();
		this.agentActivity.abort();
		for (const socket of this.inputSockets.values())
			void socket.then((ws) => ws.close()).catch(() => {});
		this.inputSockets.clear();
		await this.persistence.catch(() => {});
	}
}
export const errorMessage = (cause: unknown) =>
	cause instanceof Error ? cause.message : "Device operation failed";
const targetSession = (target: SimulatorTarget) =>
	createHash("sha256")
		.update(JSON.stringify(target))
		.digest("hex")
		.slice(0, 24);

const cleanAgentEnvironment = (): NodeJS.ProcessEnv => {
	const env = { ...process.env };
	for (const key of Object.keys(env))
		if (key.startsWith("AGENT_DEVICE_")) delete env[key];
	return env;
};

const plural = (count: number, noun: string) =>
	`${count} ${noun}${count === 1 ? "" : "s"}`;

/** The latest line with a percentage, from tools that redraw progress with `\r`. */
export const progressLine = (chunk: string) =>
	chunk
		.split(/[\r\n]+/u)
		.map((part) => part.trim())
		.filter((part) => /\d+(\.\d+)?%/u.test(part))
		.at(-1);

const pick = (device: typeof HubDevice.Type) => ({
	id: device.id,
	name: device.name,
	version: device.version,
	booted: device.booted,
});

const vendor = (platform: SimulatorPlatform) =>
	platform === "ios" ? "/vendor/serve-sim" : "/vendor/serve-emu";
