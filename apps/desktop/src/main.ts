import {
	type ChildProcessWithoutNullStreams,
	execFile,
	spawn,
} from "node:child_process";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import { createRequire } from "node:module";
import { homedir, hostname, networkInterfaces } from "node:os";
import * as Path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { AGENTS_RUNNING_COUNT_CHANNEL, AuthFlowError } from "@zuse/contracts";
import { makeMainLayer, wsServerProtocolLayer } from "@zuse/server";
import { Cause, Effect, Fiber, Layer } from "effect";
import { RpcSerialization } from "effect/unstable/rpc";
import {
	app,
	BrowserWindow,
	clipboard,
	dialog,
	ipcMain,
	Notification,
	nativeTheme,
	net,
	protocol,
	session,
	shell,
	type WebContents,
	webContents as webContentsModule,
} from "electron";
import fixPath from "fix-path";
import selfsigned from "selfsigned";

// Build verification runs the generated CommonJS bundle under Node to ensure
// its static import graph initializes without temporal-dead-zone failures.
// Exit before touching Electron APIs; production and normal development never
// set this flag.
if (process.env.ZUSE_MAIN_BUNDLE_SMOKE === "1") {
	process.exit(0);
}

// macOS GUI apps launched from Finder inherit a minimal PATH
// (`/usr/bin:/bin:/usr/sbin:/sbin`), not the user's shell PATH. The Claude
// driver runs `which claude` to locate the user's Claude Code install — that
// fails under the minimal PATH even when the binary is on Homebrew, nvm, mise,
// or npm-global. Expand PATH from the login shell before any `Command.make`
// in the server runs. Dev (`bun run dev`) inherits the terminal's PATH
// already, so we only do this when packaged. No-op on Windows.
if (
	process.platform === "darwin" &&
	app.isPackaged &&
	process.env.ZUSE_PRESERVE_PATH !== "1"
) {
	fixPath();
}

import {
	BROWSER_PARTITION,
	clearImportedBrowserCookies,
	getBrowserCookieImportStatus,
	importDefaultBrowserCookies,
	migrateExistingBrowserCookies,
} from "./browser-session-service.ts";
import { electronServerProtocolLayer } from "./ipc/electron-server-protocol.ts";
import { isLinearContextImagePath } from "./linear-context-image.ts";
import {
	DEFAULT_MENU_ACCELERATORS,
	installAppMenu,
	type MenuAccelerators,
	type MenuCommand,
} from "./menu.ts";
import {
	type ResolvedNetworkAccessState,
	readNetworkAccessPreference,
	resolveNetworkAccessState,
	writeNetworkAccessPreference,
} from "./network-access.ts";
import {
	NotchTrayController,
	type NotchTrayItem,
} from "./notch-tray-controller.ts";
import { resolveDesktopRelayPort } from "./relay-port.ts";
import {
	ensureSshEnvironment,
	listSshHosts,
	type SshEnvironmentHandle,
} from "./ssh/environment-service.ts";
import {
	getIsInstallingUpdate,
	getLastStatus,
	onStatusChange,
	registerUpdaterDemo,
	startAutoUpdater,
} from "./updater.ts";

type DiagnosticLogLevel = "debug" | "info" | "warn" | "error";

interface DiagnosticLogEntry {
	readonly createdAt: string;
	readonly level: DiagnosticLogLevel;
	readonly source: string;
	readonly message: string;
	readonly detail?: string;
}

const MAIN_DIAGNOSTIC_LOG_LIMIT = 200;
const mainDiagnosticLogs: DiagnosticLogEntry[] = [];

function stringifyDiagnosticPart(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) return `${value.name}: ${value.message}`;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function recordMainDiagnostic(
	level: DiagnosticLogLevel,
	source: string,
	parts: ReadonlyArray<unknown>,
): void {
	mainDiagnosticLogs.push({
		createdAt: new Date().toISOString(),
		level,
		source,
		message: parts.map(stringifyDiagnosticPart).join(" ").slice(0, 2000),
	});
	if (mainDiagnosticLogs.length > MAIN_DIAGNOSTIC_LOG_LIMIT) {
		mainDiagnosticLogs.splice(
			0,
			mainDiagnosticLogs.length - MAIN_DIAGNOSTIC_LOG_LIMIT,
		);
	}
}

const originalConsoleWarn = console.warn.bind(console);
const originalConsoleError = console.error.bind(console);
console.warn = (...args: unknown[]) => {
	recordMainDiagnostic("warn", "main.console", args);
	originalConsoleWarn(...args);
};
console.error = (...args: unknown[]) => {
	recordMainDiagnostic("error", "main.console", args);
	originalConsoleError(...args);
};
process.on("uncaughtException", (error) => {
	recordMainDiagnostic("error", "main.uncaughtException", [error]);
});
process.on("unhandledRejection", (reason) => {
	recordMainDiagnostic("error", "main.unhandledRejection", [reason]);
});

/**
 * Privileged scheme registration. Must run before `app.whenReady()` —
 * Electron freezes the scheme registry once the app is ready, so a late
 * call silently fails and `<img src="zuse://...">` errors out with no
 * obvious cause. `secure: true` puts the scheme in the same trust class as
 * `https`; `supportFetchAPI` lets the renderer use `fetch()` against it;
 * `stream: true` lets us hand back a body that the renderer can stream.
 */
protocol.registerSchemesAsPrivileged([
	{
		scheme: "zuse",
		privileges: {
			secure: true,
			standard: true,
			supportFetchAPI: true,
			stream: true,
		},
	},
	{
		// Legacy persisted attachment and sprite URLs from pre-Zuse builds.
		scheme: "memoize",
		privileges: {
			secure: true,
			standard: true,
			supportFetchAPI: true,
			stream: true,
		},
	},
]);

// Register `zuse://` as a default protocol client so the OS routes the
// WorkOS sign-in deep link (`zuse://auth/callback?...`) back to this app.
// Safe to call before `whenReady`. On macOS packaged builds the scheme is also
// declared in Info.plist; calling here covers dev + Win/Linux.
app.setAsDefaultProtocolClient("zuse");

// ---------------------------------------------------------------------------
// Auth callback bridge. The WorkOS PKCE flow round-trips through the system
// browser. We catch the callback two ways and funnel either into the embedded
// server's AuthService (which registers `deliverAuthUrl` via the `authShell`
// dep below):
//
//   1. A localhost loopback HTTP server (primary). Custom-scheme deep links are
//      unreliable in dev on macOS — every project's prebuilt `Electron.app`
//      shares the bundle id `com.github.Electron`, so the OS routes
//      `zuse://` to an arbitrary one (or a fresh, app-less copy → the
//      default Electron splash). Loopback HTTP has none of that ambiguity and
//      works identically in dev and packaged builds.
//   2. The `zuse://auth/callback` deep link (open-url / second-instance),
//      kept for the future mobile/packaged path.
//
// A callback can arrive before the server runtime (and thus the sink) exists —
// buffer and flush on register (R2).
// ---------------------------------------------------------------------------
const AUTH_LOOPBACK_PORTS = [8976, 8977, 8978, 8979] as const;
// Both dev and packaged use the loopback as the WorkOS redirect_uri. It's the
// RFC 8252 native-app pattern and gives a strictly better sign-in finish:
//   - the browser lands on a real HTML page ("Signed in, you can close this
//     tab") instead of a dead `zuse://` URL that leaves the tab hanging, and
//   - no OS "Open in Zuse Alpha?" prompt — the browser hits localhost and the
//     already-running app answers directly, no deep-link handoff needed.
// The `zuse://auth/callback` scheme handler stays registered below as a
// fallback (and the future mobile path), but is no longer the primary flow.
// Register `http://localhost:8976/callback` through `:8979` in the WorkOS
// dashboard so parallel worktree instances can each finish sign-in.
const AUTH_DEEP_LINK_SCHEMES = ["zuse://", "memoize://"] as const;

const isAuthDeepLink = (arg: string): boolean =>
	AUTH_DEEP_LINK_SCHEMES.some((scheme) => arg.startsWith(scheme));

let deliverAuthUrl: ((url: string) => void) | null = null;
let pendingAuthUrls: string[] = [];
let deliverLinearUrl: ((url: string) => void) | null = null;
let pendingLinearUrls: string[] = [];

const handleAuthCallback = (url: string): void => {
	let isLinear = false;
	try {
		const parsed = new URL(url);
		isLinear =
			parsed.pathname === "/linear/callback" || parsed.hostname === "linear";
	} catch {
		// Invalid callback URLs are delivered to the account flow and rejected there.
	}
	if (isLinear) {
		if (deliverLinearUrl !== null) deliverLinearUrl(url);
		else pendingLinearUrls.push(url);
		return;
	}
	if (deliverAuthUrl !== null) {
		deliverAuthUrl(url);
	} else {
		pendingAuthUrls.push(url);
	}
};

const focusMainWindow = (): void => {
	if (mainWindow === null) return;
	if (!mainWindow.isVisible()) mainWindow.show();
	if (mainWindow.isMinimized()) mainWindow.restore();
	app.focus({ steal: true });
	mainWindow.focus();
};

let authLoopbackServer: http.Server | null = null;
let boundAuthPort: number | null = null;
let authLoopbackFailure: string | null = null;

const tryListenAuthLoopback = (
	server: http.Server,
	port: number,
): Promise<boolean> =>
	new Promise((resolve) => {
		const onError = (err: NodeJS.ErrnoException) => {
			server.off("listening", onListening);
			if (err.code !== "EADDRINUSE") {
				console.error("[zuse] auth loopback server error", err);
			}
			resolve(false);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve(true);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, "127.0.0.1");
	});

const startAuthLoopback = async (): Promise<void> => {
	if (authLoopbackServer !== null) return;
	const server = http.createServer((req, res) => {
		const requestUrl = req.url ?? "";
		let parsed: URL;
		try {
			parsed = new URL(
				`http://localhost:${boundAuthPort ?? AUTH_LOOPBACK_PORTS[0]}${requestUrl}`,
			);
		} catch {
			res.writeHead(400);
			res.end();
			return;
		}
		if (
			parsed.pathname !== "/callback" &&
			parsed.pathname !== "/linear/callback"
		) {
			res.writeHead(404);
			res.end("Not found");
			return;
		}
		handleAuthCallback(parsed.toString());
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(
			`<!doctype html><meta charset="utf-8"><title>Zuse Alpha</title>` +
				`<body style="font-family:-apple-system,system-ui,sans-serif;background:#0b0b0c;color:#e5e5e5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">` +
				`<div style="text-align:center"><h2 style="font-weight:600">Signed in</h2>` +
				`<p style="color:#a3a3a3">You can close this tab and return to Zuse Alpha.</p></div>`,
		);
		focusMainWindow();
	});
	for (const port of AUTH_LOOPBACK_PORTS) {
		if (await tryListenAuthLoopback(server, port)) {
			boundAuthPort = port;
			authLoopbackServer = server;
			authLoopbackFailure = null;
			return;
		}
	}
	authLoopbackFailure =
		"Sign-in port unavailable. Close other Zuse windows and retry.";
	server.close();
};

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL?.trim() || "";
const isDevelopment = Boolean(DEV_SERVER_URL);

const APP_NAME = isDevelopment ? "Zuse Alpha (Dev)" : "Zuse Alpha";
const DESKTOP_SOURCE_DIR =
	process.env.ZUSE_DESKTOP_DIR?.trim() || Path.resolve(__dirname, "..");
const DEV_ICON_PATH = Path.resolve(DESKTOP_SOURCE_DIR, "build", "icon.png");

app.setName(APP_NAME);
if (
	isDevelopment &&
	process.platform === "darwin" &&
	fsSync.existsSync(DEV_ICON_PATH)
) {
	app.dock?.setIcon(DEV_ICON_PATH);
}

const ZUSE_USER_DATA_DIR =
	process.env.ZUSE_USER_DATA_DIR?.trim() ||
	process.env.MEMOIZE_USER_DATA_DIR?.trim();
if (ZUSE_USER_DATA_DIR) {
	fsSync.mkdirSync(ZUSE_USER_DATA_DIR, { recursive: true });
	app.setPath("userData", ZUSE_USER_DATA_DIR);
}

// Single-instance lock: required so a deep link launched while the app is
// already running routes through `second-instance` (Win/Linux) rather than
// spawning a second copy. macOS delivers via `open-url` regardless. App name
// and userData must be set first so dev workspaces don't collide with the
// packaged app or with each other.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
	app.quit();
}

// macOS: deep links arrive here (also on cold launch, before whenReady).
app.on("open-url", (event, url) => {
	event.preventDefault();
	handleAuthCallback(url);
});

// Start dark to preserve the historical launch appearance. The renderer sends
// the persisted Light / Dark / System preference after settings hydrate.
nativeTheme.themeSource = "dark";

ipcMain.on("window:setAppearanceMode", (_event, value: unknown) => {
	if (value !== "system" && value !== "light" && value !== "dark") return;
	nativeTheme.themeSource = value;
});

let mainWindow: BrowserWindow | null = null;
let runtimeFiber: Fiber.Fiber<void, never> | null = null;
let notchTray: NotchTrayController | null = null;
let localConnectivityHelper: ChildProcessWithoutNullStreams | null = null;
let localConnectivityRestartTimer: ReturnType<typeof setTimeout> | null = null;
let localConnectivityRestartAttempt = 0;
let localConnectivityStopping = false;

const rendererDistDir = (): string =>
	app.isPackaged
		? Path.join(process.resourcesPath, "app", "renderer", "dist")
		: process.env.ZUSE_RENDERER_DIST_DIR?.trim() ||
			Path.resolve(DESKTOP_SOURCE_DIR, "..", "renderer", "dist");

// Win/Linux: a second launch (e.g. the OS opening the deep link) lands here in
// the primary instance. Pull any auth deep-link arg out of its argv and focus
// the existing window.
app.on("second-instance", (_event, argv) => {
	const url = argv.find(isAuthDeepLink);
	if (url !== undefined) handleAuthCallback(url);
	focusMainWindow();
});
const USER_APPLICATIONS_DIR = Path.join(homedir(), "Applications");
const execFileAsync = promisify(execFile);

const appendAppLog = (fileName: string, line: string): void => {
	try {
		const filePath = Path.join(app.getPath("userData"), "logs", fileName);
		fsSync.mkdirSync(Path.dirname(filePath), { recursive: true });
		fsSync.appendFileSync(filePath, `${line}\n`, "utf8");
	} catch {
		// Logging must never affect app behavior.
	}
};

const appendRemoteConnectionLog = (
	event: string,
	fields: Record<string, unknown> = {},
): void => {
	appendAppLog(
		"remote-connection.log",
		JSON.stringify({
			ts: new Date().toISOString(),
			event,
			...Object.fromEntries(
				Object.entries(fields).map(([key, value]) => [
					key,
					value instanceof Error
						? { name: value.name, message: value.message }
						: value,
				]),
			),
		}),
	);
};

const localConnectivityHelperPath = (): string =>
	app.isPackaged
		? Path.join(
				process.resourcesPath,
				"app",
				"local-connectivity",
				"zuse-local-connectivity",
			)
		: Path.join(
				app.getAppPath(),
				"native",
				"local-connectivity",
				"bin",
				"zuse-local-connectivity",
			);

const browserCredentialHelperPath = (): string =>
	app.isPackaged
		? Path.join(
				process.resourcesPath,
				"app",
				"browser-credentials",
				"zuse-browser-credentials",
			)
		: Path.join(
				app.getAppPath(),
				"native",
				"browser-credentials",
				"bin",
				"zuse-browser-credentials",
			);

const probeNativeCredentialHelper = async (): Promise<{
	readonly supported: boolean;
	readonly reason?: string;
}> => {
	if (process.platform !== "darwin") {
		return {
			supported: false,
			reason: "Native password filling is currently available only on macOS.",
		};
	}
	const executable = browserCredentialHelperPath();
	if (!fsSync.existsSync(executable)) {
		return {
			supported: false,
			reason: "The native password helper is not installed in this build.",
		};
	}
	try {
		const { stdout } = await execFileAsync(executable, ["--probe"], {
			timeout: 5_000,
			maxBuffer: 16 * 1024,
		});
		const result = JSON.parse(stdout) as { supported?: unknown };
		return result.supported === true
			? { supported: true }
			: {
					supported: false,
					reason: "The native password helper failed its capability probe.",
				};
	} catch {
		return {
			supported: false,
			reason: "The native password helper failed its capability probe.",
		};
	}
};

type LocalTrustRecord = {
	readonly recordId: string;
	readonly secret: string;
};

const ensureLocalTrustRecord = async (
	userData: string,
): Promise<LocalTrustRecord | null> => {
	if (process.platform !== "darwin") return null;
	const executable = localConnectivityHelperPath();
	if (!fsSync.existsSync(executable)) return null;
	const metadataPath = Path.join(userData, "local-connectivity-trust.json");
	let recordId: string;
	try {
		const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as {
			recordId?: unknown;
		};
		recordId =
			typeof metadata.recordId === "string" && metadata.recordId.length <= 128
				? metadata.recordId
				: randomUUID();
	} catch {
		recordId = randomUUID();
	}
	try {
		await fs.mkdir(Path.dirname(metadataPath), { recursive: true });
		await fs.writeFile(metadataPath, JSON.stringify({ recordId }), {
			mode: 0o600,
		});
		const { stdout } = await execFileAsync(executable, [
			"--ensure-trust",
			recordId,
		]);
		const result = JSON.parse(stdout) as {
			recordId?: unknown;
			secret?: unknown;
		};
		if (
			result.recordId !== recordId ||
			typeof result.secret !== "string" ||
			!/^[A-Za-z0-9_-]{43}$/.test(result.secret)
		) {
			return null;
		}
		return { recordId, secret: result.secret };
	} catch (cause) {
		appendRemoteConnectionLog("local.trust.unavailable", {
			reason: cause instanceof Error ? cause.message : String(cause),
		});
		return null;
	}
};

const startLocalConnectivityHelper = (
	targetPort: number,
	serviceName: string,
	trustRecordId?: string,
	tlsCertificatePin?: string,
): void => {
	if (process.platform !== "darwin" || localConnectivityHelper !== null) return;
	const executable = localConnectivityHelperPath();
	if (!fsSync.existsSync(executable)) {
		appendRemoteConnectionLog("local.helper.unavailable", { executable });
		return;
	}
	const child = spawn(
		executable,
		[
			String(targetPort),
			serviceName,
			trustRecordId ?? "-",
			...(tlsCertificatePin === undefined ? [] : [tlsCertificatePin]),
		],
		{
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	localConnectivityHelper = child;
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		for (const line of chunk.trim().split("\n")) {
			if (line.includes('"event":"listener.ready"')) {
				localConnectivityRestartAttempt = 0;
			}
			if (line.length > 0)
				appendRemoteConnectionLog("local.helper.event", { line });
		}
	});
	child.stderr.on("data", (chunk: string) => {
		appendRemoteConnectionLog("local.helper.stderr", { message: chunk.trim() });
	});
	child.once("exit", (code, signal) => {
		if (localConnectivityHelper === child) localConnectivityHelper = null;
		appendRemoteConnectionLog("local.helper.exit", { code, signal });
		if (localConnectivityStopping) return;
		localConnectivityRestartAttempt += 1;
		const delayMs = Math.min(
			16_000,
			1_000 * 2 ** Math.max(0, localConnectivityRestartAttempt - 1),
		);
		localConnectivityRestartTimer = setTimeout(() => {
			localConnectivityRestartTimer = null;
			startLocalConnectivityHelper(
				targetPort,
				serviceName,
				trustRecordId,
				tlsCertificatePin,
			);
		}, delayMs);
	});
	child.once("error", (cause) => {
		appendRemoteConnectionLog("local.helper.spawn_failed", { cause });
	});
};

type NearbyTlsIdentity = {
	readonly key: string;
	readonly cert: string;
	readonly pin: string;
};

const ensureNearbyTlsIdentity = async (
	userData: string,
): Promise<NearbyTlsIdentity> => {
	const directory = Path.join(userData, "local-connectivity");
	const keyPath = Path.join(directory, "nearby-key.pem");
	const certPath = Path.join(directory, "nearby-cert.pem");
	let key: string;
	let cert: string;
	try {
		[key, cert] = await Promise.all([
			fs.readFile(keyPath, "utf8"),
			fs.readFile(certPath, "utf8"),
		]);
	} catch {
		const generated = await selfsigned.generate(
			[{ name: "commonName", value: "Zuse Nearby" }],
			{
				notAfterDate: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000),
				keySize: 2048,
				algorithm: "sha256",
			},
		);
		key = generated.private;
		cert = generated.cert;
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		await Promise.all([
			fs.writeFile(keyPath, key, { mode: 0o600 }),
			fs.writeFile(certPath, cert, { mode: 0o600 }),
		]);
	}
	const raw = new X509Certificate(cert).raw;
	return {
		key,
		cert,
		pin: createHash("sha256").update(raw).digest("base64url"),
	};
};

type OpenTargetDefinition = {
	readonly id: string;
	readonly label: string;
	readonly appName: string | null;
	readonly appPaths: ReadonlyArray<string>;
	readonly iconNames?: ReadonlyArray<string>;
	readonly iconPaths?: ReadonlyArray<string>;
};

const OPEN_TARGETS: ReadonlyArray<OpenTargetDefinition> = [
	{
		id: "finder",
		label: "Finder",
		appName: null,
		appPaths: ["/System/Library/CoreServices/Finder.app"],
		iconNames: ["Finder"],
		iconPaths: [
			"/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/FinderIcon.icns",
		],
	},
	{
		id: "cursor",
		label: "Cursor",
		appName: "Cursor",
		appPaths: [
			"/Applications/Cursor.app",
			Path.join(USER_APPLICATIONS_DIR, "Cursor.app"),
		],
		iconNames: ["Cursor"],
	},
	{
		id: "vscode",
		label: "VS Code",
		appName: "Visual Studio Code",
		appPaths: [
			"/Applications/Visual Studio Code.app",
			Path.join(USER_APPLICATIONS_DIR, "Visual Studio Code.app"),
			"/Applications/Visual Studio Code - Insiders.app",
			Path.join(USER_APPLICATIONS_DIR, "Visual Studio Code - Insiders.app"),
		],
		iconNames: ["Code", "Visual Studio Code", "VSCode"],
	},
	{
		id: "windsurf",
		label: "Windsurf",
		appName: "Windsurf",
		appPaths: [
			"/Applications/Windsurf.app",
			Path.join(USER_APPLICATIONS_DIR, "Windsurf.app"),
		],
		iconNames: ["Windsurf"],
	},
	{
		id: "zed",
		label: "Zed",
		appName: "Zed",
		appPaths: [
			"/Applications/Zed.app",
			Path.join(USER_APPLICATIONS_DIR, "Zed.app"),
		],
		iconNames: ["Zed"],
	},
	{
		id: "xcode",
		label: "Xcode",
		appName: "Xcode",
		appPaths: [
			"/Applications/Xcode.app",
			Path.join(USER_APPLICATIONS_DIR, "Xcode.app"),
		],
		iconNames: ["Xcode"],
	},
	{
		id: "ghostty",
		label: "Ghostty",
		appName: "Ghostty",
		appPaths: [
			"/Applications/Ghostty.app",
			Path.join(USER_APPLICATIONS_DIR, "Ghostty.app"),
		],
		iconNames: ["Ghostty"],
	},
	{
		id: "terminal",
		label: "Terminal",
		appName: "Terminal",
		appPaths: ["/System/Applications/Utilities/Terminal.app"],
		iconNames: ["Terminal"],
	},
	{
		id: "antigravity",
		label: "Antigravity",
		appName: "Antigravity",
		appPaths: [
			"/Applications/Antigravity.app",
			Path.join(USER_APPLICATIONS_DIR, "Antigravity.app"),
		],
		iconNames: ["Antigravity"],
	},
];

const openTargetById = new Map(
	OPEN_TARGETS.map((target) => [target.id, target]),
);

const pathExists = async (path: string): Promise<boolean> => {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
};

const firstExistingPath = async (
	paths: ReadonlyArray<string>,
): Promise<string | null> => {
	for (const candidate of paths) {
		if (await pathExists(candidate)) return candidate;
	}
	return null;
};

const normalizeIconHint = (value: string): string =>
	value.toLowerCase().replace(/[^a-z0-9]/g, "");

const plistRawValue = async (
	plistPath: string,
	key: string,
): Promise<string | null> => {
	try {
		const { stdout } = await execFileAsync(
			"/usr/bin/plutil",
			["-extract", key, "raw", "-o", "-", plistPath],
			{ encoding: "utf8" },
		);
		const value = stdout.trim();
		return value.length === 0 ? null : value;
	} catch {
		return null;
	}
};

const iconFileNames = (iconName: string): ReadonlyArray<string> => {
	const trimmed = iconName.trim();
	if (trimmed.length === 0) return [];
	return trimmed.toLowerCase().endsWith(".icns")
		? [trimmed]
		: [trimmed, `${trimmed}.icns`];
};

const bundleDeclaredIconNames = async (
	appPath: string,
): Promise<ReadonlyArray<string>> => {
	const plistPath = Path.join(appPath, "Contents", "Info.plist");
	const names = await Promise.all([
		plistRawValue(plistPath, "CFBundleIconFile"),
		plistRawValue(plistPath, "CFBundleIconName"),
	]);
	return names.flatMap((name) => (name === null ? [] : iconFileNames(name)));
};

const bundleIconPath = async (
	target: OpenTargetDefinition,
	appPath: string | null,
): Promise<string | null> => {
	const explicitIconPath = await firstExistingPath(target.iconPaths ?? []);
	if (explicitIconPath !== null) return explicitIconPath;
	if (appPath === null) return null;

	const resourcesPath = Path.join(appPath, "Contents", "Resources");
	const declaredIconNames = await bundleDeclaredIconNames(appPath);
	const candidateIconNames = [
		...declaredIconNames,
		...(target.iconNames ?? []).flatMap(iconFileNames),
	];

	for (const fileName of candidateIconNames) {
		const candidate = Path.join(resourcesPath, fileName);
		if (await pathExists(candidate)) return candidate;
	}

	let entries: ReadonlyArray<string>;
	try {
		entries = await fs.readdir(resourcesPath);
	} catch {
		return null;
	}

	const hints = [target.label, target.appName ?? "", target.id]
		.filter((value) => value.length > 0)
		.map(normalizeIconHint);
	const genericIconNames = new Set(["document", "default", "file", "text"]);
	const scored = entries
		.filter((entry) => entry.toLowerCase().endsWith(".icns"))
		.map((entry) => {
			const baseName = normalizeIconHint(Path.basename(entry, ".icns"));
			let score = 0;
			if (hints.includes(baseName)) score += 100;
			else if (
				hints.some(
					(hint) =>
						hint.length > 0 &&
						(baseName.includes(hint) || hint.includes(baseName)),
				)
			) {
				score += 80;
			}
			if (genericIconNames.has(baseName)) score -= 50;
			return { entry, score };
		})
		.sort((left, right) => right.score - left.score);

	const best = scored.find((item) => item.score > 0) ?? scored[0];
	return best === undefined ? null : Path.join(resourcesPath, best.entry);
};

const appIconDataUrl = async (
	target: OpenTargetDefinition,
	appPath: string | null,
): Promise<string | null> => {
	const iconPath = await bundleIconPath(target, appPath);
	if (iconPath === null) return null;
	try {
		const stat = await fs.stat(iconPath);
		const cacheDir = Path.join(app.getPath("userData"), "open-target-icons");
		await fs.mkdir(cacheDir, { recursive: true });
		const cacheName = `${target.id}-${stat.size}-${Math.floor(stat.mtimeMs)}.png`;
		const pngPath = Path.join(cacheDir, cacheName);
		if (!(await pathExists(pngPath))) {
			await execFileAsync(
				"/usr/bin/sips",
				["-s", "format", "png", iconPath, "--out", pngPath],
				{ encoding: "utf8" },
			);
		}
		const data = await fs.readFile(pngPath);
		return `data:image/png;base64,${data.toString("base64")}`;
	} catch {
		return null;
	}
};

const openWithApp = (appSpecifier: string, targetPath: string): Promise<void> =>
	new Promise((resolve, reject) => {
		const child = spawn("open", ["-a", appSpecifier, targetPath], {
			stdio: "ignore",
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`open exited with code ${code ?? "null"}`));
		});
	});

// Electron's dialog is the only host-shell API the server reaches for. Wrap
// it here so apps/server stays free of any UI-toolkit imports — see ADR 0007.
//
// `showHiddenFiles` is critical on macOS: NSOpenPanel hides dotfile dirs
// (`~/.claude`, `~/.config`, `~/.ssh`, …) by default, so without it the user
// literally cannot navigate into anything under a hidden parent — they
// appear stuck in whatever folder the dialog opens in. `defaultPath: home`
// puts the dialog in a sensible starting place (the user's home dir) instead
// of the Electron process's cwd, which on a packaged build is the app bundle.
const folderPicker = {
	pick: () =>
		Effect.promise(() =>
			dialog.showOpenDialog({
				defaultPath: app.getPath("home"),
				properties: ["openDirectory", "createDirectory", "showHiddenFiles"],
			}),
		).pipe(
			Effect.map((result) =>
				result.canceled || result.filePaths.length === 0
					? null
					: (result.filePaths[0] ?? null),
			),
		),
};

// The WorkOS OAuth deep-link seam for the server's AuthService (ADR 0007 keeps
// apps/server free of electron). `open` launches the system browser; the
// server hands us its callback sink via `onCallbackUrl`, which we store in the
// module-level `deliverAuthUrl` and prime with any deep links buffered before
// the runtime came up.
const authShell = {
	get redirectUri() {
		return `http://localhost:${boundAuthPort ?? AUTH_LOOPBACK_PORTS[0]}/callback`;
	},
	get linearRedirectUri() {
		return `http://localhost:${boundAuthPort ?? AUTH_LOOPBACK_PORTS[0]}/linear/callback`;
	},
	open: (url: string) =>
		Effect.tryPromise({
			try: async () => {
				if (boundAuthPort === null) {
					throw new Error(
						authLoopbackFailure ??
							"Sign-in port unavailable. Close other Zuse windows and retry.",
					);
				}
				await shell.openExternal(url);
			},
			catch: (cause) =>
				new AuthFlowError({
					reason:
						cause instanceof Error
							? `Could not open browser: ${cause.message}`
							: "Could not open browser.",
				}),
		}),
	onCallbackUrl: (handler: (url: string) => void) =>
		Effect.sync(() => {
			deliverAuthUrl = handler;
			const queued = pendingAuthUrls;
			pendingAuthUrls = [];
			for (const url of queued) handler(url);
		}),
	onLinearCallbackUrl: (handler: (url: string) => void) =>
		Effect.sync(() => {
			deliverLinearUrl = handler;
			const queued = pendingLinearUrls;
			pendingLinearUrls = [];
			for (const url of queued) handler(url);
		}),
};

async function createMainWindow() {
	const relayPort = await resolveDesktopRelayPort({
		configuredPort: process.env.ZUSE_DESKTOP_WS_PORT,
	});
	const userData = app.getPath("userData");
	const networkAccessEnabled = await readNetworkAccessPreference(userData);
	const systemHostname = hostname();
	const stableLocalHost =
		process.platform === "darwin" &&
		systemHostname.toLowerCase().endsWith(".local")
			? systemHostname
			: null;
	let networkAccess: ResolvedNetworkAccessState;
	try {
		networkAccess = resolveNetworkAccessState({
			enabled: networkAccessEnabled,
			port: relayPort.port,
			interfaces: networkInterfaces(),
			stableHost: stableLocalHost,
		});
	} catch (cause) {
		recordMainDiagnostic("warn", "network-access", [cause]);
		networkAccess = resolveNetworkAccessState({
			enabled: false,
			port: relayPort.port,
			interfaces: networkInterfaces(),
			stableHost: stableLocalHost,
		});
	}
	const isMac = process.platform === "darwin";
	const localTrust =
		networkAccess.mode === "network-accessible"
			? await ensureLocalTrustRecord(userData)
			: null;
	const nearbyTls =
		networkAccess.mode === "network-accessible" && process.platform === "darwin"
			? await ensureNearbyTlsIdentity(userData)
			: null;
	mainWindow = new BrowserWindow({
		width: 1280,
		height: 800,
		minWidth: 720,
		minHeight: 480,
		// macOS vibrancy needs the window itself to be transparent — without
		// `transparent: true` Electron paints an opaque background and the
		// vibrancy never shows through. `backgroundColor: "#00000000"` (alpha 0)
		// pairs with it so there's no flash of solid color before render.
		show: false,
		...(isMac
			? {
					vibrancy: "sidebar" as const,
					visualEffectState: "active" as const,
					transparent: true,
					backgroundColor: "#00000000",
				}
			: { backgroundColor: "#0b0b0c" }),
		...(fsSync.existsSync(DEV_ICON_PATH) ? { icon: DEV_ICON_PATH } : {}),
		titleBarStyle: isMac ? "hiddenInset" : "default",
		title: APP_NAME,
		webPreferences: {
			preload: Path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			// Enables the `<webview>` tag the in-app Browser tab uses. The webview
			// itself still runs with `nodeIntegration: false` in its own process,
			// so this only unlocks the element, not Node access inside it.
			webviewTag: true,
		},
	});

	// Avoid the white flash that transparent windows show before first paint.
	mainWindow.once("ready-to-show", () => mainWindow?.show());

	// Renderer needs to know fullscreen state to drop the macOS traffic-light
	// gutter (the controls hide in native fullscreen, so the 80px reserve is
	// dead space). We push the current state on first paint plus on every
	// toggle — a fresh boot in fullscreen still gets the initial value.
	const sendFullScreenState = () => {
		if (mainWindow === null) return;
		mainWindow.webContents.send("window:fullscreen", mainWindow.isFullScreen());
	};

	const sshEnvironmentHandles = new Map<string, SshEnvironmentHandle>();
	mainWindow.on("enter-full-screen", sendFullScreenState);
	mainWindow.on("leave-full-screen", sendFullScreenState);
	mainWindow.webContents.on("did-finish-load", sendFullScreenState);

	// Hand off http(s) URLs to the OS default browser via `shell.openExternal`
	// — the renderer asked to leave Electron, not to host another Chromium
	// window inside the app. Allowlist scheme so the bridge can't be coaxed
	// into running arbitrary shell URI handlers.
	const openHttpExternal = (rawUrl: unknown): boolean => {
		if (typeof rawUrl !== "string") return false;
		let parsed: URL;
		try {
			parsed = new URL(rawUrl);
		} catch {
			return false;
		}
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
			return false;
		}
		void shell.openExternal(parsed.toString());
		return true;
	};

	ipcMain.on("app:openExternal", (_event, rawUrl: unknown) => {
		openHttpExternal(rawUrl);
	});

	ipcMain.handle("app:listOpenTargets", async (_event, rawPath: unknown) => {
		if (typeof rawPath !== "string" || rawPath.length === 0) return [];
		const existingPath = await pathExists(rawPath);
		if (!existingPath) return [];

		return Promise.all(
			OPEN_TARGETS.map(async (target) => {
				const appPath = await firstExistingPath(target.appPaths);
				const alwaysAvailable =
					target.id === "finder" || target.id === "terminal";
				const iconDataUrl = await appIconDataUrl(target, appPath);
				const available = alwaysAvailable || appPath !== null;
				return {
					id: target.id,
					label: target.label,
					available,
					iconDataUrl,
				};
			}),
		);
	});

	ipcMain.handle(
		"app:openPathInApp",
		async (_event, rawPath: unknown, rawAppId: unknown) => {
			if (typeof rawPath !== "string" || typeof rawAppId !== "string") return;
			if (!(await pathExists(rawPath))) return;
			const target = openTargetById.get(rawAppId);
			if (target === undefined) return;
			if (target.id === "finder") {
				shell.showItemInFolder(rawPath);
				return;
			}
			const appPath = await firstExistingPath(target.appPaths);
			const appSpecifier = appPath ?? target.appName;
			if (appSpecifier === null) return;
			await openWithApp(appSpecifier, rawPath);
		},
	);

	ipcMain.handle("app:revealPath", async (_event, rawPath: unknown) => {
		if (typeof rawPath !== "string") return;
		if (!(await pathExists(rawPath))) return;
		shell.showItemInFolder(rawPath);
	});

	ipcMain.handle("app:copyPath", async (_event, rawPath: unknown) => {
		if (typeof rawPath !== "string") return;
		if (!(await pathExists(rawPath))) return;
		clipboard.writeText(rawPath);
	});

	ipcMain.handle("app:copyFileContents", async (_event, rawPath: unknown) => {
		if (typeof rawPath !== "string") return false;
		if (!(await pathExists(rawPath))) return false;
		const text = await fs.readFile(rawPath, "utf8");
		clipboard.writeText(text);
		return true;
	});

	ipcMain.handle("app:getMainDiagnostics", () => mainDiagnosticLogs.slice());

	ipcMain.handle("network:getAccessState", () => ({
		mode: networkAccess.mode,
		advertisedHost: networkAccess.advertisedHost,
		endpointUrl: networkAccess.endpointUrl,
		port: networkAccess.port,
	}));
	ipcMain.handle(
		"network:setAccessEnabled",
		async (_event, enabled: unknown) => {
			if (typeof enabled !== "boolean") {
				throw new TypeError("Network access must be enabled or disabled.");
			}
			const next = resolveNetworkAccessState({
				enabled,
				port: relayPort.port,
				interfaces: networkInterfaces(),
				stableHost: stableLocalHost,
			});
			await writeNetworkAccessPreference(userData, enabled);
			if (next.mode !== networkAccess.mode) {
				setTimeout(() => {
					app.relaunch();
					app.exit(0);
				}, 250);
			}
			return {
				mode: next.mode,
				advertisedHost: next.advertisedHost,
				endpointUrl: next.endpointUrl,
				port: next.port,
			};
		},
	);

	ipcMain.handle("ssh:listHosts", async () => listSshHosts());

	ipcMain.handle("ssh:ensureEnvironment", async (_event, rawHost: unknown) => {
		if (typeof rawHost !== "string" || rawHost.trim().length === 0) {
			return null;
		}
		const host = rawHost.trim();
		const existing = sshEnvironmentHandles.get(host);
		if (existing !== undefined) return existing.descriptor;
		const handle = await ensureSshEnvironment(host);
		sshEnvironmentHandles.set(host, handle);
		return handle.descriptor;
	});

	// ---------------------------------------------------------------------------
	// Agent browser CDP bridge
	//
	// The in-app `<webview>` runs in its own Chromium webContents. To drive it
	// with real mouse/keyboard input (so `:hover` styles fire, drag works, and
	// React-controlled inputs see authentic key events), we attach Chrome
	// DevTools Protocol to that webContents and dispatch through `Input.*`.
	// Synthetic DOM events from `executeJavaScript` look like clicks to the page
	// but bypass Chromium's input pipeline — no hover, no native focus ring, no
	// realistic timing. The renderer renders the cursor itself, so we just have
	// to deliver real input here.
	//
	// The renderer hands us its webview's webContentsId via
	// `browser:registerWebview` on `dom-ready`. We attach once and re-attach on
	// crash. Detach happens automatically when the webContents is destroyed.
	// ---------------------------------------------------------------------------

	// Track which webContentsIds we've attached to so registerWebview is
	// idempotent (the renderer fires it on every `dom-ready`, including reloads).
	const attachedWebContents = new Set<number>();
	// Event taps (debugger message listener + webContents listeners) survive a
	// debugger detach/re-attach cycle, so they install once per webContents —
	// re-installing on every crash-recovery attach would double every buffered
	// page error and unload-allow.
	const tappedWebContents = new Set<number>();

	// Per-webview observability buffers, fed by CDP events below. Network keeps
	// insertion order (Map) so "recent requests" reads oldest→newest; both are
	// cleared on every main-frame load start so the agent's `browser_network` /
	// `browser_console` reads describe the current page, mirroring the
	// renderer's own console ring buffer.
	type NetworkEntry = {
		id: string;
		method: string;
		url: string;
		resourceType?: string;
		status?: number;
		mimeType?: string;
		responseHeaders?: Record<string, string>;
		failed?: string;
	};
	const NETWORK_LOG_CAP = 300;
	const PAGE_ERROR_CAP = 100;
	const browserNetworkLog = new Map<number, Map<string, NetworkEntry>>();
	const browserPageErrors = new Map<number, string[]>();
	const browserPendingDialog = new Map<
		number,
		{ type: string; message: string; defaultPrompt?: string }
	>();
	const browserScreencasts = new Map<
		number,
		{ owner: WebContents; awaitingRenderer: boolean }
	>();

	const dropBrowserBuffers = (id: number): void => {
		browserNetworkLog.delete(id);
		browserPageErrors.delete(id);
		browserPendingDialog.delete(id);
	};

	const detachDebugger = (id: number): void => {
		const screencast = browserScreencasts.get(id);
		if (screencast !== undefined && !screencast.owner.isDestroyed()) {
			screencast.owner.send("browser:screencastInterrupted", id);
		}
		browserScreencasts.delete(id);
		const wc = webContentsModule.fromId(id);
		if (wc === undefined || wc.isDestroyed()) {
			attachedWebContents.delete(id);
			dropBrowserBuffers(id);
			return;
		}
		try {
			if (wc.debugger.isAttached()) wc.debugger.detach();
		} catch {
			// Detach failures are non-fatal — the webContents may be tearing down.
		}
		attachedWebContents.delete(id);
		dropBrowserBuffers(id);
	};

	/**
	 * Route CDP events into the per-webview buffers. Registered once per
	 * attach; Electron drops the listener with the webContents.
	 */
	const installCdpEventTaps = (id: number, wc: WebContents): void => {
		wc.debugger.on("message", (_event, method, rawParams) => {
			const params = (rawParams ?? {}) as Record<string, unknown>;
			switch (method) {
				case "Network.requestWillBeSent": {
					let log = browserNetworkLog.get(id);
					if (log === undefined) {
						log = new Map();
						browserNetworkLog.set(id, log);
					}
					const request = params.request as Record<string, unknown> | undefined;
					log.set(String(params.requestId), {
						id: String(params.requestId),
						method: String(request?.method ?? "GET"),
						url: String(request?.url ?? ""),
						resourceType:
							typeof params.type === "string" ? params.type : undefined,
					});
					if (log.size > NETWORK_LOG_CAP) {
						const oldest = log.keys().next().value;
						if (oldest !== undefined) log.delete(oldest);
					}
					return;
				}
				case "Network.responseReceived": {
					const entry = browserNetworkLog
						.get(id)
						?.get(String(params.requestId));
					if (entry === undefined) return;
					const response = params.response as
						| Record<string, unknown>
						| undefined;
					entry.status = Number(response?.status ?? 0);
					entry.mimeType =
						typeof response?.mimeType === "string"
							? response.mimeType
							: undefined;
					const headers = response?.headers;
					if (headers !== null && typeof headers === "object") {
						entry.responseHeaders = headers as Record<string, string>;
					}
					return;
				}
				case "Network.loadingFailed": {
					const entry = browserNetworkLog
						.get(id)
						?.get(String(params.requestId));
					if (entry !== undefined) {
						entry.failed = String(params.errorText ?? "failed");
					}
					return;
				}
				case "Runtime.exceptionThrown": {
					const details = params.exceptionDetails as
						| Record<string, unknown>
						| undefined;
					const exception = details?.exception as
						| Record<string, unknown>
						| undefined;
					const description =
						exception?.description ?? details?.text ?? "Uncaught exception";
					const where =
						typeof details?.url === "string" && details.url.length > 0
							? ` (${details.url}:${details.lineNumber ?? 0})`
							: "";
					const errors = browserPageErrors.get(id) ?? [];
					errors.push(
						`[uncaught] ${String(description).slice(0, 500)}${where}`,
					);
					if (errors.length > PAGE_ERROR_CAP) {
						errors.splice(0, errors.length - PAGE_ERROR_CAP);
					}
					browserPageErrors.set(id, errors);
					return;
				}
				case "Page.javascriptDialogOpening": {
					browserPendingDialog.set(id, {
						type: String(params.type ?? "alert"),
						message: String(params.message ?? ""),
						defaultPrompt:
							typeof params.defaultPrompt === "string"
								? params.defaultPrompt
								: undefined,
					});
					return;
				}
				case "Page.javascriptDialogClosed": {
					browserPendingDialog.delete(id);
					return;
				}
				case "Page.screencastFrame": {
					void wc.debugger
						.sendCommand("Page.screencastFrameAck", {
							sessionId: params.sessionId,
						})
						.catch(() => {});
					const screencast = browserScreencasts.get(id);
					if (
						screencast === undefined ||
						screencast.awaitingRenderer ||
						screencast.owner.isDestroyed() ||
						typeof params.data !== "string"
					)
						return;
					screencast.awaitingRenderer = true;
					screencast.owner.send("browser:screencastFrame", {
						webContentsId: id,
						data: params.data,
					});
					return;
				}
				default:
					return;
			}
		});
	};

	/**
	 * Turn on the CDP domains the v2 tools read from. Best-effort per domain —
	 * a domain that fails to enable (older Chromium, experimental surface)
	 * degrades that one capability, not the whole browser.
	 */
	const enableCdpDomains = async (wc: WebContents): Promise<void> => {
		for (const method of [
			"Network.enable",
			"Runtime.enable",
			"Page.enable",
			"DOM.enable",
			"Accessibility.enable",
		]) {
			try {
				await wc.debugger.sendCommand(method);
			} catch (err) {
				console.error(`[zuse] CDP ${method} failed`, err);
			}
		}
	};

	ipcMain.handle("browser:registerWebview", async (_event, rawId: unknown) => {
		if (typeof rawId !== "number" || !Number.isInteger(rawId)) return false;
		const wc = webContentsModule.fromId(rawId);
		if (wc === undefined || wc.isDestroyed()) return false;
		if (attachedWebContents.has(rawId) && wc.debugger.isAttached()) return true;
		try {
			// Protocol 1.3 is the stable baseline that ships with every modern
			// Chromium; older revisions don't accept `Input.dispatchMouseEvent`
			// payload fields we rely on (`pointerType`, `tangentialPressure`).
			// Experimental domains (Accessibility) still work — the attached
			// debugger speaks the running Chromium's full protocol.
			wc.debugger.attach("1.3");
			attachedWebContents.add(rawId);
			if (!tappedWebContents.has(rawId)) {
				tappedWebContents.add(rawId);
				installCdpEventTaps(rawId, wc);
				// Fresh page → the previous page's requests/errors are stale.
				wc.on("did-start-loading", () => {
					browserNetworkLog.get(rawId)?.clear();
					browserPageErrors.get(rawId)?.splice(0);
				});
				// A page's beforeunload handler must not wedge agent navigation — the
				// user watched the agent ask for the navigation, so always let it
				// proceed (this is what a user clicking "Leave" would do).
				wc.on("will-prevent-unload", (event) => {
					event.preventDefault();
				});
				// Auto-cleanup when the webContents goes away (window close, webview
				// teardown, full crash). Without this, a `Another debugger is already
				// attached` error fires on the next register-after-reload.
				wc.once("destroyed", () => {
					const screencast = browserScreencasts.get(rawId);
					if (screencast !== undefined && !screencast.owner.isDestroyed()) {
						screencast.owner.send("browser:screencastInterrupted", rawId);
					}
					browserScreencasts.delete(rawId);
					attachedWebContents.delete(rawId);
					tappedWebContents.delete(rawId);
					dropBrowserBuffers(rawId);
				});
				wc.on("render-process-gone", () => detachDebugger(rawId));
			}
			await enableCdpDomains(wc);
			return true;
		} catch (err) {
			// The only expected failure here is "already attached by DevTools" —
			// surface so the renderer can fall back gracefully.
			console.error("[zuse] failed to attach CDP debugger", err);
			return false;
		}
	});

	/**
	 * Allowlisted CDP passthrough for the agent-browser renderer. The renderer
	 * already holds `executeJavaScript` on the same webview, so this grants no
	 * new page-level power — the list just keeps the seam from becoming a
	 * generic protocol proxy (no Target.*, no Browser.*, no Input.* — input
	 * stays on the dedicated `browser:dispatchInput` path).
	 */
	const CDP_ALLOWED_METHODS = new Set([
		"Accessibility.getFullAXTree",
		"DOM.getDocument",
		"DOM.scrollIntoViewIfNeeded",
		"DOM.getContentQuads",
		"DOM.resolveNode",
		"Runtime.callFunctionOn",
		"Page.captureScreenshot",
		"Page.handleJavaScriptDialog",
	]);

	ipcMain.handle(
		"browser:cdpCommand",
		async (_event, rawId: unknown, rawMethod: unknown, rawParams: unknown) => {
			if (typeof rawId !== "number" || !Number.isInteger(rawId)) {
				return { ok: false as const, error: "bad webContents id" };
			}
			if (
				typeof rawMethod !== "string" ||
				!CDP_ALLOWED_METHODS.has(rawMethod)
			) {
				return {
					ok: false as const,
					error: `method not allowed: ${String(rawMethod)}`,
				};
			}
			const wc = webContentsModule.fromId(rawId);
			if (wc === undefined || wc.isDestroyed() || !wc.debugger.isAttached()) {
				return { ok: false as const, error: "debugger not attached" };
			}
			try {
				const result = await wc.debugger.sendCommand(
					rawMethod,
					rawParams !== null && typeof rawParams === "object"
						? (rawParams as Record<string, unknown>)
						: {},
				);
				// Dialog resolution isn't always reported back via
				// javascriptDialogClosed on every Chromium; clear eagerly.
				if (rawMethod === "Page.handleJavaScriptDialog") {
					browserPendingDialog.delete(rawId);
				}
				return { ok: true as const, result };
			} catch (err) {
				return {
					ok: false as const,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		},
	);

	ipcMain.handle("browser:startScreencast", async (event, rawId: unknown) => {
		if (typeof rawId !== "number" || !Number.isInteger(rawId)) return false;
		const wc = webContentsModule.fromId(rawId);
		if (
			wc === undefined ||
			wc.isDestroyed() ||
			!wc.debugger.isAttached() ||
			browserScreencasts.has(rawId)
		)
			return false;
		try {
			browserScreencasts.set(rawId, {
				owner: event.sender,
				awaitingRenderer: false,
			});
			await wc.debugger.sendCommand("Page.startScreencast", {
				format: "jpeg",
				quality: 85,
				everyNthFrame: 1,
			});
			return true;
		} catch {
			browserScreencasts.delete(rawId);
			return false;
		}
	});

	ipcMain.on("browser:ackScreencastFrame", (_event, rawId: unknown) => {
		if (typeof rawId !== "number") return;
		const screencast = browserScreencasts.get(rawId);
		if (screencast !== undefined) screencast.awaitingRenderer = false;
	});

	ipcMain.handle("browser:stopScreencast", async (_event, rawId: unknown) => {
		if (typeof rawId !== "number" || !Number.isInteger(rawId)) return false;
		browserScreencasts.delete(rawId);
		const wc = webContentsModule.fromId(rawId);
		if (wc === undefined || wc.isDestroyed() || !wc.debugger.isAttached())
			return false;
		try {
			await wc.debugger.sendCommand("Page.stopScreencast");
			return true;
		} catch {
			return false;
		}
	});

	ipcMain.handle(
		"browser:getNetwork",
		async (_event, rawId: unknown, rawQuery: unknown) => {
			if (typeof rawId !== "number" || !Number.isInteger(rawId)) return null;
			const log = browserNetworkLog.get(rawId);
			if (log === undefined) return { requests: [] };
			const query = (rawQuery ?? {}) as { filter?: unknown; id?: unknown };
			if (typeof query.id === "string" && query.id.length > 0) {
				const entry = log.get(query.id);
				if (entry === undefined) return null;
				// Body comes straight from the CDP buffer; truncated so one XHR
				// can't blow up the agent's context.
				let body: string | undefined;
				let bodyBase64 = false;
				const wc = webContentsModule.fromId(rawId);
				if (wc !== undefined && !wc.isDestroyed() && wc.debugger.isAttached()) {
					try {
						const res = (await wc.debugger.sendCommand(
							"Network.getResponseBody",
							{ requestId: entry.id },
						)) as { body?: string; base64Encoded?: boolean };
						bodyBase64 = res.base64Encoded === true;
						body =
							typeof res.body === "string"
								? res.body.slice(0, 4000)
								: undefined;
					} catch {
						// Body may be gone (evicted, streamed, or a non-buffered type) —
						// detail without a body is still useful.
					}
				}
				return { detail: { ...entry, body, bodyBase64 } };
			}
			const filter =
				typeof query.filter === "string" && query.filter.length > 0
					? query.filter.toLowerCase()
					: null;
			const requests = [...log.values()]
				.filter(
					(entry) =>
						filter === null || entry.url.toLowerCase().includes(filter),
				)
				.map(({ responseHeaders: _headers, ...summary }) => summary);
			return { requests };
		},
	);

	ipcMain.handle("browser:getPageErrors", async (_event, rawId: unknown) => {
		if (typeof rawId !== "number" || !Number.isInteger(rawId)) return [];
		return [...(browserPageErrors.get(rawId) ?? [])];
	});

	ipcMain.handle("browser:getDialogState", async (_event, rawId: unknown) => {
		if (typeof rawId !== "number" || !Number.isInteger(rawId)) return null;
		return browserPendingDialog.get(rawId) ?? null;
	});

	ipcMain.handle("browser:getCookieImportStatus", async () => {
		const persistent = session.fromPartition(BROWSER_PARTITION);
		await migrateExistingBrowserCookies(
			app.getPath("userData"),
			session.defaultSession,
			persistent,
		);
		return getBrowserCookieImportStatus(app.getPath("userData"));
	});

	ipcMain.handle("browser:importCookies", async (_event, profileId: unknown) =>
		importDefaultBrowserCookies(
			app.getPath("userData"),
			session.fromPartition(BROWSER_PARTITION),
			typeof profileId === "string" ? profileId : undefined,
		),
	);

	ipcMain.handle("browser:clearImportedCookies", async () =>
		clearImportedBrowserCookies(
			app.getPath("userData"),
			session.fromPartition(BROWSER_PARTITION),
		),
	);

	ipcMain.handle("browser:clearBrowsingData", async () => {
		const userData = app.getPath("userData");
		const persistent = session.fromPartition(BROWSER_PARTITION);
		await clearImportedBrowserCookies(userData, persistent);
		await persistent.clearStorageData();
		await persistent.clearCache();
		return getBrowserCookieImportStatus(userData);
	});

	ipcMain.handle("browser:getNativeCredentialCapability", async () =>
		probeNativeCredentialHelper(),
	);

	ipcMain.handle(
		"browser:fillNativeCredential",
		async (_event, rawId: unknown, rawOrigin: unknown, rawSubmit: unknown) => {
			if (typeof rawId !== "number" || typeof rawOrigin !== "string")
				return { ok: false, error: "Invalid native credential request." };
			const wc = webContentsModule.fromId(rawId);
			if (wc === undefined || wc.isDestroyed())
				return { ok: false, error: "The browser surface is unavailable." };
			let activeOrigin: string;
			let requestedOrigin: string;
			try {
				activeOrigin = new URL(wc.getURL()).origin;
				requestedOrigin = new URL(rawOrigin).origin;
			} catch {
				return { ok: false, error: "A valid active page origin is required." };
			}
			if (activeOrigin !== requestedOrigin)
				return {
					ok: false,
					error: "Credential origin does not match the active page.",
				};
			const capability = await probeNativeCredentialHelper();
			if (!capability.supported) {
				return {
					ok: false,
					error:
						capability.reason ??
						"Native Passwords access is unavailable in this build.",
				};
			}
			try {
				const { stdout } = await execFileAsync(
					browserCredentialHelperPath(),
					[requestedOrigin],
					{
						timeout: 120_000,
						maxBuffer: 64 * 1024,
					},
				);
				const selected = JSON.parse(stdout) as {
					ok?: unknown;
					username?: unknown;
					password?: unknown;
					error?: unknown;
				};
				if (
					selected.ok !== true ||
					typeof selected.username !== "string" ||
					typeof selected.password !== "string"
				) {
					return {
						ok: false,
						error:
							typeof selected.error === "string"
								? selected.error
								: "No password was selected.",
					};
				}
				if (
					wc.isDestroyed() ||
					new URL(wc.getURL()).origin !== requestedOrigin
				) {
					return {
						ok: false,
						error: "The page changed before the credential could be filled.",
					};
				}
				const result = (await wc.executeJavaScript(
					`(() => { const username = ${JSON.stringify(selected.username)}; const password = ${JSON.stringify(selected.password)}; const passwordField = document.querySelector('input[type="password"]'); if (!(passwordField instanceof HTMLInputElement)) return { ok: false, error: 'No password field is focused or visible on this page.' }; const usernameField = document.querySelector('input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i]') || Array.from(document.querySelectorAll('input')).find((element) => element instanceof HTMLInputElement && /^(text|email)$/.test(element.type)); const setValue = (element, value) => { const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); descriptor?.set?.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); }; if (usernameField instanceof HTMLInputElement) setValue(usernameField, username); setValue(passwordField, password); ${rawSubmit === true ? "if (passwordField.form?.requestSubmit) passwordField.form.requestSubmit();" : "passwordField.focus();"} return { ok: true }; })()`,
					true,
				)) as { ok?: unknown; error?: unknown };
				return result.ok === true
					? { ok: true }
					: {
							ok: false,
							error:
								typeof result.error === "string"
									? result.error
									: "The selected password could not be filled.",
						};
			} catch (error) {
				return {
					ok: false,
					error:
						error instanceof Error && error.message.includes("timed out")
							? "Password selection timed out."
							: "Password selection was cancelled or unavailable.",
				};
			}
		},
	);

	ipcMain.handle("browser:listLocalServers", async () => {
		try {
			const byPort = new Map<number, string>();
			if (process.platform === "darwin") {
				const { stdout } = await execFileAsync("lsof", [
					"-nP",
					"-iTCP",
					"-sTCP:LISTEN",
				]);
				for (const line of stdout.split("\n").slice(1)) {
					const trimmed = line.trim();
					if (trimmed.length === 0) continue;
					const parts = trimmed.split(/\s+/);
					const command = parts[0] ?? "server";
					const endpoint = parts.find((part) => /:(\d+)$/.test(part));
					const match = endpoint?.match(/:(\d+)$/);
					if (match === undefined || match === null) continue;
					const port = Number(match[1]);
					if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
					if (!byPort.has(port)) byPort.set(port, command.slice(0, 48));
				}
			} else {
				const { stdout } = await execFileAsync("netstat", ["-an"]);
				for (const line of stdout.split("\n")) {
					if (!/\bLISTEN(?:ING)?\b/i.test(line)) continue;
					const match = line.match(
						/(?:127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|\*)[.:](\d+)/,
					);
					if (match === null) continue;
					const port = Number(match[1]);
					if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
					if (!byPort.has(port)) byPort.set(port, "localhost");
				}
			}
			return [...byPort.entries()]
				.sort(([left], [right]) => left - right)
				.slice(0, 50)
				.map(([port, name]) => ({ name, port }));
		} catch {
			return [];
		}
	});

	ipcMain.handle(
		"browser:saveRecording",
		async (
			_event,
			rawBytes: unknown,
			rawMime: unknown,
			rawDuration: unknown,
		) => {
			if (!(rawBytes instanceof Uint8Array)) {
				throw new Error("Recording bytes are invalid.");
			}
			if (
				rawBytes.byteLength === 0 ||
				rawBytes.byteLength > 300 * 1024 * 1024
			) {
				throw new Error("Recording must be between 1 byte and 300 MB.");
			}
			const mimeType = rawMime === "video/mp4" ? "video/mp4" : "video/webm";
			const extension = mimeType === "video/mp4" ? "mp4" : "webm";
			const id = randomUUID();
			const createdAt = new Date().toISOString();
			const directory = Path.join(app.getPath("userData"), "browser-artifacts");
			await fs.mkdir(directory, { recursive: true, mode: 0o700 });
			const target = Path.join(directory, `${id}.${extension}`);
			await fs.writeFile(target, rawBytes, { mode: 0o600 });
			return {
				id,
				type: mimeType,
				size: rawBytes.byteLength,
				durationMs: Math.max(
					0,
					Math.min(10 * 60 * 1000, Number(rawDuration) || 0),
				),
				createdAt,
			};
		},
	);

	ipcMain.handle(
		"browser:dispatchInput",
		async (_event, rawId: unknown, rawAction: unknown) => {
			if (typeof rawId !== "number" || !Number.isInteger(rawId)) return false;
			if (rawAction === null || typeof rawAction !== "object") return false;
			const wc = webContentsModule.fromId(rawId);
			if (wc === undefined || wc.isDestroyed()) return false;
			if (!wc.debugger.isAttached()) return false;

			const action = rawAction as Record<string, unknown>;
			const type = action.type;
			try {
				switch (type) {
					case "mouseMove":
					case "mousePressed":
					case "mouseReleased": {
						const x = Number(action.x);
						const y = Number(action.y);
						if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
						const button =
							typeof action.button === "string"
								? action.button
								: type === "mouseMove"
									? "none"
									: "left";
						const clickCount = Math.max(
							0,
							Math.min(
								3,
								Number(action.clickCount ?? (type === "mouseMove" ? 0 : 1)),
							),
						);
						await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
							type,
							x,
							y,
							button,
							buttons: type === "mouseMove" ? 0 : 1,
							clickCount,
							pointerType: "mouse",
						});
						return true;
					}
					case "mouseWheel": {
						const x = Number(action.x);
						const y = Number(action.y);
						const deltaX = Number(action.deltaX ?? 0);
						const deltaY = Number(action.deltaY ?? 0);
						if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
						await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
							type: "mouseWheel",
							x,
							y,
							button: "none",
							deltaX,
							deltaY,
							pointerType: "mouse",
						});
						return true;
					}
					case "keyDown":
					case "keyUp":
					case "char": {
						const key = typeof action.key === "string" ? action.key : "";
						const text =
							typeof action.text === "string" ? action.text : undefined;
						const code =
							typeof action.code === "string" ? action.code : undefined;
						const windowsVirtualKeyCode =
							typeof action.windowsVirtualKeyCode === "number"
								? action.windowsVirtualKeyCode
								: undefined;
						await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
							type,
							key,
							...(text !== undefined ? { text } : {}),
							...(code !== undefined ? { code } : {}),
							...(windowsVirtualKeyCode !== undefined
								? { windowsVirtualKeyCode }
								: {}),
						});
						return true;
					}
					case "insertText": {
						const text = typeof action.text === "string" ? action.text : "";
						if (text.length === 0) return true;
						await wc.debugger.sendCommand("Input.insertText", { text });
						return true;
					}
					default:
						return false;
				}
			} catch (err) {
				console.error("[zuse] CDP dispatch failed", err);
				return false;
			}
		},
	);

	// Markdown links rendered by react-markdown have no `target="_blank"`, so a
	// click triggers an in-window navigation away from the renderer — the app
	// would unload and Chromium would render the page inline, indistinguishable
	// from "the app froze." Intercept those and route to the OS browser.
	mainWindow.webContents.on("will-navigate", (event, url) => {
		// Allow same-document navigations (dev-server HMR, our own renderer's
		// file:// load, the privileged `zuse://` scheme). Everything else is
		// an external link the user clicked.
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return;
		}
		if (parsed.protocol === "http:" || parsed.protocol === "https:") {
			// In dev the renderer is served from http://localhost:<port> — don't
			// hijack navigations inside the renderer itself.
			if (isDevelopment && parsed.origin === new URL(DEV_SERVER_URL).origin) {
				return;
			}
			event.preventDefault();
			void shell.openExternal(parsed.toString());
		}
	});

	// `target="_blank"` and `window.open()` go through the window-open handler
	// instead of will-navigate. Default behavior is to spawn a new
	// BrowserWindow hosting the URL — i.e. the "in-app browser" the user was
	// seeing. Deny the new window and route http(s) externally.
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		openHttpExternal(url);
		return { action: "deny" };
	});

	// Backstops so any stray http(s) link click in the shell webContents
	// (markdown anchors without an onClick, target="_blank" forms, etc.)
	// punts to the OS default browser instead of opening a child Electron
	// window or navigating the SPA away. The in-app Browser tab uses a
	// `<webview>` which runs in its own webContents and isn't affected.
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		try {
			const parsed = new URL(url);
			if (parsed.protocol === "http:" || parsed.protocol === "https:") {
				void shell.openExternal(parsed.toString());
			}
		} catch {
			// not a parseable URL — drop silently
		}
		return { action: "deny" };
	});
	mainWindow.webContents.on("will-navigate", (event, url) => {
		try {
			const parsed = new URL(url);
			if (parsed.protocol === "http:" || parsed.protocol === "https:") {
				event.preventDefault();
				void shell.openExternal(parsed.toString());
			}
		} catch {
			// file:// (renderer index) and other internal schemes fall through
		}
	});

	// Boot the Effect runtime once the window's webContents exists. The RPC
	// server protocol is bound to this webContents, so a window restart means
	// a fresh runtime — the only Effect.runFork in the main process.
	const serverProtocol = electronServerProtocolLayer(
		mainWindow.webContents,
	).pipe(Layer.provide(RpcSerialization.layerJson));
	const relayWsPort = relayPort.port;
	const relayWsProtocol = wsServerProtocolLayer({
		port: relayWsPort,
		host: networkAccess.bindHost,
		staticDir: isDevelopment ? undefined : rendererDistDir(),
		devServerUrl: isDevelopment ? DEV_SERVER_URL : undefined,
		onDiagnostic: appendRemoteConnectionLog,
	});
	const nearbyWsProtocol =
		nearbyTls === null
			? null
			: wsServerProtocolLayer({
					port: 0,
					host: "127.0.0.1",
					tls: { key: nearbyTls.key, cert: nearbyTls.cert },
					onDiagnostic: appendRemoteConnectionLog,
					onListening: ({ port }) =>
						startLocalConnectivityHelper(
							port,
							systemHostname,
							localTrust?.recordId,
							nearbyTls.pin,
						),
				});
	appendRemoteConnectionLog("desktop.runtime.start", {
		relayWsPort,
		userData: app.getPath("userData"),
	});
	if (relayPort.fellBack) {
		appendRemoteConnectionLog("desktop.runtime.port_fallback", {
			relayWsPort,
		});
	}
	process.env.ZUSE_APP_VERSION = app.getVersion();

	runtimeFiber = Effect.runFork(
		Layer.launch(
			makeMainLayer({
				userData,
				folderPicker,
				serverProtocol,
				additionalServerProtocols: [
					relayWsProtocol,
					...(nearbyWsProtocol === null ? [] : [nearbyWsProtocol]),
				],
				authShell,
				lanAuth: {
					policy: "protected",
					advertisedHost: networkAccess.advertisedHost,
					port: relayWsPort,
					pairingBootstrap: false,
					icloudTrustRecordId: localTrust?.recordId,
					icloudTrustSecret: localTrust?.secret,
					transportCertificatePin: nearbyTls?.pin,
					onNearbyPairingRequest: (request) => {
						const requestFields = {
							requestId: request.requestId,
							deviceIdentifier: request.deviceIdentifier,
						};
						const rendererAvailable =
							mainWindow !== null &&
							!mainWindow.isDestroyed() &&
							!mainWindow.webContents.isDestroyed();
						appendRemoteConnectionLog("pairing.nearby.request_received", {
							...requestFields,
							rendererAvailable,
						});
						console.info("[zuse:pairing] desktop.request.received", {
							...requestFields,
							rendererAvailable,
						});

						try {
							focusMainWindow();
							console.info(
								"[zuse:pairing] desktop.window.focused",
								requestFields,
							);
						} catch (cause) {
							appendRemoteConnectionLog("pairing.nearby.window_focus_failed", {
								...requestFields,
								cause,
							});
							console.error(
								"[zuse:pairing] desktop.window.focus_failed",
								cause,
							);
						}

						if (Notification.isSupported()) {
							try {
								const notification = new Notification({
									title: "Phone wants to connect",
									body: `${request.deviceLabel} · Device ${request.deviceIdentifier}`,
								});
								notification.on("click", focusMainWindow);
								notification.show();
								console.info(
									"[zuse:pairing] desktop.notification.shown",
									requestFields,
								);
							} catch (cause) {
								appendRemoteConnectionLog(
									"pairing.nearby.notification_failed",
									{ ...requestFields, cause },
								);
								console.error(
									"[zuse:pairing] desktop.notification.failed",
									cause,
								);
							}
						} else {
							console.info(
								"[zuse:pairing] desktop.notification.unsupported",
								requestFields,
							);
						}

						if (!rendererAvailable || mainWindow === null) {
							console.error(
								"[zuse:pairing] desktop.renderer.unavailable",
								requestFields,
							);
							return;
						}
						try {
							mainWindow.webContents.send("pairing:nearby-request", request);
							console.info(
								"[zuse:pairing] desktop.renderer.sent",
								requestFields,
							);
						} catch (cause) {
							appendRemoteConnectionLog("pairing.nearby.renderer_send_failed", {
								...requestFields,
								cause,
							});
							console.error(
								"[zuse:pairing] desktop.renderer.send_failed",
								cause,
							);
						}
					},
				},
			}),
		).pipe(
			Effect.catchCause((cause) =>
				Effect.sync(() => {
					// Boot-time layer failures (sqlite open, migrator, config) are
					// unrecoverable — surface the cause and bail. Quiet
					// success-after-restart is preferable to a half-running app.
					const detail = Cause.pretty(cause);
					appendRemoteConnectionLog("desktop.runtime.fatal", { cause: detail });
					console.error("[zuse] fatal boot error\n", detail);
					app.exit(1);
				}),
			),
		),
	);
	// Persist renderer console output so UI-side races can be diagnosed from
	// disk after the fact. In dev we also mirror it into the terminal.
	mainWindow.webContents.on(
		"console-message",
		(_event, level, message, line, source) => {
			const payload = JSON.stringify({
				ts: new Date().toISOString(),
				level,
				message,
				source,
				line,
			});
			appendAppLog("renderer.log", payload);
			if (isDevelopment) console.log(`[renderer] ${message}`);
		},
	);

	if (isDevelopment) {
		void mainWindow.loadURL(DEV_SERVER_URL);
		mainWindow.webContents.openDevTools({ mode: "right" });
	} else {
		// In dev `dist-electron/main.cjs` lives at apps/desktop/dist-electron/
		// and the renderer is two levels up at apps/renderer/dist. In the
		// packaged bundle the renderer is shipped via `extraResources` to
		// <app>/Contents/Resources/app/renderer/dist (see
		// apps/desktop/electron-builder.yml).
		const rendererIndex = Path.join(rendererDistDir(), "index.html");
		void mainWindow.loadFile(rendererIndex);
	}

	mainWindow.on("closed", () => {
		mainWindow = null;
		if (runtimeFiber !== null) {
			void Effect.runPromise(Fiber.interrupt(runtimeFiber));
			runtimeFiber = null;
		}
	});
}

/**
 * Resolve internal asset URLs to files under userData:
 *   - `zuse://attachments/<id>`
 *   - `zuse://pokemon/<dex-number>` or `zuse://pokemon/<dex-number>-<variant>`
 * The id has no extension on the wire so we scan the directory for a file
 * with the matching stem. Anything outside known hosts is rejected.
 */
const ATTACHMENTS_HOST = "attachments";
const POKEMON_HOST = "pokemon";
const LINEAR_CONTEXT_HOST = "linear-context";

const MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	avif: "image/avif",
	svg: "image/svg+xml",
};

type AssetFilenameCache = {
	readonly byStem: Map<string, string>;
	loaded: boolean;
};

const refreshAssetFilenameCache = async (
	assetDir: string,
	cache: AssetFilenameCache,
): Promise<void> => {
	const entries = await fs.readdir(assetDir);
	cache.byStem.clear();
	for (const name of entries) {
		const dot = name.lastIndexOf(".");
		if (dot > 0) cache.byStem.set(name.slice(0, dot), name);
	}
	cache.loaded = true;
};

const findAssetFilename = async (
	assetDir: string,
	cache: AssetFilenameCache,
	id: string,
): Promise<string | null> => {
	if (!cache.loaded) {
		await refreshAssetFilenameCache(assetDir, cache);
	}
	const cached = cache.byStem.get(id);
	if (cached !== undefined) return cached;

	await refreshAssetFilenameCache(assetDir, cache);
	return cache.byStem.get(id) ?? null;
};

const ZUSE_SQLITE_FILENAME = "zuse.sqlite";

// Attachment ids resolve to an immutable on-disk path, so caching id → path
// avoids re-opening the DB for every `<img>` request.
const attachmentPathCache = new Map<string, string>();

/**
 * Resolve `<id>` → the attachment blob's absolute path via a read-only probe
 * of the app database. Blobs now live in each workspace's per-session
 * `.context/files/` dir (recorded in `attachments.abs_path`), so a single-dir
 * scan can no longer find them. Returns `null` on any failure (missing row,
 * NULL `abs_path`, or DB unavailable) — the caller then tries the legacy
 * flat-dir layout.
 */
const resolveAttachmentAbsPathFromDb = (
	userData: string,
	id: string,
): string | null => {
	const cached = attachmentPathCache.get(id);
	if (cached !== undefined) return cached;
	try {
		// Lazy require: `node:sqlite` is a builtin in this Electron's Node
		// runtime — the same client the server uses.
		const req = createRequire(import.meta.url);
		const { DatabaseSync } = req("node:sqlite") as typeof import("node:sqlite");
		const db = new DatabaseSync(Path.join(userData, ZUSE_SQLITE_FILENAME), {
			readOnly: true,
		});
		try {
			const row = db
				.prepare("SELECT abs_path FROM attachments WHERE id = ?")
				.get(id) as { abs_path?: string | null } | undefined;
			const abs = typeof row?.abs_path === "string" ? row.abs_path : null;
			if (abs !== null) attachmentPathCache.set(id, abs);
			return abs;
		} finally {
			db.close();
		}
	} catch {
		return null;
	}
};

/**
 * Defense-in-depth: only serve a DB-recorded path when it lives inside the
 * legacy attachments dir or a `.context/files` directory. The path is
 * server-written and the id is already sanitised, but this keeps a corrupted
 * row from turning the protocol into an arbitrary-file reader.
 */
const isServableAttachmentPath = (
	attachmentsDir: string,
	p: string,
): boolean => {
	const norm = Path.normalize(p);
	return (
		norm.startsWith(attachmentsDir + Path.sep) ||
		norm.includes(`${Path.sep}.context${Path.sep}files${Path.sep}`)
	);
};

const registerZuseProtocol = (): void => {
	const attachmentsDir = Path.join(app.getPath("userData"), "attachments");
	const pokemonDir = Path.join(app.getPath("userData"), "pokemon-sprites");
	const attachmentFilenames: AssetFilenameCache = {
		byStem: new Map(),
		loaded: false,
	};
	const pokemonFilenames: AssetFilenameCache = {
		byStem: new Map(),
		loaded: false,
	};

	const handleAssetRequest = async (request: Request) => {
		const url = new URL(request.url);
		if (url.host === LINEAR_CONTEXT_HOST) {
			try {
				const requestedPath = decodeURIComponent(url.pathname);
				const realPath = await fs.realpath(requestedPath);
				if (!isLinearContextImagePath(realPath)) {
					return new Response(null, { status: 403 });
				}
				const ext = Path.extname(realPath).slice(1).toLowerCase();
				const mime = MIME_BY_EXT[ext];
				if (mime === undefined) return new Response(null, { status: 415 });
				const response = await net.fetch(pathToFileURL(realPath).toString());
				const headers = new Headers(response.headers);
				headers.set("content-type", mime);
				headers.set("cache-control", "private, max-age=3600");
				return new Response(response.body, {
					status: response.status,
					headers,
				});
			} catch {
				return new Response(null, { status: 404 });
			}
		}
		if (url.host !== ATTACHMENTS_HOST && url.host !== POKEMON_HOST) {
			return new Response(null, { status: 404 });
		}

		// The path is `/<id>`; sanitise to a single segment so a crafted url
		// like `zuse://attachments/../foo` cannot escape the asset dirs.
		const id = decodeURIComponent(url.pathname.replace(/^\//, ""));
		if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) {
			return new Response(null, { status: 400 });
		}

		let absPath: string | null = null;
		if (url.host === ATTACHMENTS_HOST) {
			// Prefer the DB-recorded absolute path (new `.context/files` layout).
			const fromDb = resolveAttachmentAbsPathFromDb(
				app.getPath("userData"),
				id,
			);
			if (fromDb !== null && isServableAttachmentPath(attachmentsDir, fromDb)) {
				absPath = fromDb;
			} else {
				// Legacy fallback: scan the flat userData/attachments dir for
				// pre-migration blobs.
				try {
					const filename = await findAssetFilename(
						attachmentsDir,
						attachmentFilenames,
						id,
					);
					if (filename) absPath = Path.join(attachmentsDir, filename);
				} catch {
					absPath = null;
				}
			}
		} else {
			try {
				const filename = await findAssetFilename(
					pokemonDir,
					pokemonFilenames,
					id,
				);
				if (filename) absPath = Path.join(pokemonDir, filename);
			} catch {
				absPath = null;
			}
		}

		if (absPath === null) return new Response(null, { status: 404 });

		const base = Path.basename(absPath);
		const ext = base.slice(base.lastIndexOf(".") + 1).toLowerCase();
		const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";

		const response = await net.fetch(pathToFileURL(absPath).toString());
		const headers = new Headers(response.headers);
		headers.set("content-type", mime);
		headers.set("cache-control", "private, max-age=31536000, immutable");
		return new Response(response.body, {
			status: response.status,
			headers,
		});
	};

	protocol.handle("zuse", handleAssetRequest);
	protocol.handle("memoize", handleAssetRequest);
};

/**
 * Validate a renderer-supplied accelerator map before handing it to
 * `installAppMenu`. Anything missing or non-string falls through to the
 * default for that command so a bad payload can't blank out the menu.
 */
const sanitizeAccelerators = (raw: unknown): MenuAccelerators => {
	if (raw === null || typeof raw !== "object") {
		return DEFAULT_MENU_ACCELERATORS;
	}
	const obj = raw as Record<string, unknown>;
	const out: Record<MenuCommand, string | null> = {
		...DEFAULT_MENU_ACCELERATORS,
	};
	for (const cmd of Object.keys(DEFAULT_MENU_ACCELERATORS) as MenuCommand[]) {
		const v = obj[cmd];
		if (v === null) {
			out[cmd] = null;
		} else if (typeof v === "string") {
			out[cmd] = v;
		}
	}
	return out;
};

// Renderer → main: "the user's keybindings just changed, please re-install
// the menu with these accelerators." Renderer owns the defaults + override
// resolution since its keybindings store is the live mirror of the JSON
// config file.
// Latest values for the two independent inputs that drive the menu shape.
// `menu:setAccelerators` and the auto-updater status listener both rebuild
// the menu, but each only knows about its own input — without remembering
// the other, a status flip would blow away custom keybindings (and vice
// versa).
let lastAccelerators: MenuAccelerators = DEFAULT_MENU_ACCELERATORS;

ipcMain.on("menu:setAccelerators", (_event, payload: unknown) => {
	lastAccelerators = sanitizeAccelerators(payload);
	installAppMenu(() => mainWindow, lastAccelerators, getLastStatus());
});

const isNotchItemState = (value: unknown): value is NotchTrayItem["state"] =>
	value === "running" ||
	value === "completed" ||
	value === "failed" ||
	value === "planReady" ||
	value === "question" ||
	value === "permission";

const sanitizeNotchItems = (raw: unknown): ReadonlyArray<NotchTrayItem> => {
	if (!Array.isArray(raw)) return [];
	const out: NotchTrayItem[] = [];
	for (const item of raw) {
		if (item === null || typeof item !== "object") continue;
		const obj = item as Record<string, unknown>;
		if (
			typeof obj.id !== "string" ||
			typeof obj.chatId !== "string" ||
			typeof obj.sessionId !== "string" ||
			typeof obj.title !== "string" ||
			typeof obj.subtitle !== "string" ||
			typeof obj.label !== "string" ||
			typeof obj.updatedAt !== "number" ||
			!isNotchItemState(obj.state)
		) {
			continue;
		}
		out.push({
			id: obj.id,
			chatId: obj.chatId,
			sessionId: obj.sessionId,
			title: obj.title.slice(0, 160),
			subtitle: obj.subtitle.slice(0, 180),
			state: obj.state,
			label: obj.label.slice(0, 80),
			updatedAt: obj.updatedAt,
		});
		if (out.length >= 12) break;
	}
	return out;
};

ipcMain.on("notch:setItems", (_event, payload: unknown) => {
	notchTray?.setItems(sanitizeNotchItems(payload));
});

ipcMain.on("notch:setEnabled", (_event, value: unknown) => {
	notchTray?.setEnabled(value === true);
});

ipcMain.on("notch:setPinned", (_event, value: unknown) => {
	notchTray?.setPinned(value === true);
});

ipcMain.on("notch:setExpanded", (_event, value: unknown) => {
	notchTray?.setHovered(value === true);
});

ipcMain.on(
	"notch:openChat",
	(_event, rawChatId: unknown, rawSessionId: unknown) => {
		if (typeof rawChatId !== "string" || typeof rawSessionId !== "string")
			return;
		focusMainWindow();
		mainWindow?.webContents.send("notch:openChat", {
			chatId: rawChatId,
			sessionId: rawSessionId,
		});
	},
);

ipcMain.handle(
	"notch:getDisplaySupport",
	() =>
		notchTray?.getSupport() ?? {
			supported: false,
			reason:
				process.platform === "darwin" ? "no-notched-display" : "not-macos",
		},
);

void app.whenReady().then(async () => {
	// Non-primary instance is on its way out (lost the single-instance lock) —
	// don't build a window or boot the runtime.
	if (!gotSingleInstanceLock) return;

	// Localhost loopback that catches the WorkOS OAuth callback (dev + packaged).
	// It's the redirect_uri for both, so the browser finishes on a real HTML
	// page and no `zuse://` deep-link handoff/prompt is needed. The scheme
	// handler stays registered below as a fallback.
	await startAuthLoopback();

	// Win/Linux cold launch from a deep link: the URL is an argv entry.
	const initialDeepLink = process.argv.find(isAuthDeepLink);
	if (initialDeepLink !== undefined) handleAuthCallback(initialDeepLink);

	registerZuseProtocol();
	notchTray = new NotchTrayController({
		preloadPath: Path.join(__dirname, "preload.cjs"),
		devServerUrl: DEV_SERVER_URL,
		packagedRendererDir: rendererDistDir(),
	});

	// Populate the native About panel so "About Zuse" shows the current
	// version + copyright. Without this, Electron's default panel only shows
	// the app name. macOS reads these once at panel-open time, so it's safe
	// to call once on startup.
	app.setAboutPanelOptions({
		applicationName: "Zuse Alpha",
		applicationVersion: app.getVersion(),
		version: app.getVersion(),
		copyright: "© Swaraj Bachu",
		website: "https://github.com/swarajbachu/zuse",
	});

	// Rebuild the menu whenever the updater status changes so the
	// "Check for Updates…" item label/enabled state stays live — this is the
	// user's fallback path when the in-app toast is dismissed or a download
	// stalls mid-way. The subscription is set up once; the listener runs on
	// every status flip.
	onStatusChange((status) => {
		installAppMenu(() => mainWindow, lastAccelerators, status);
	});

	installAppMenu(() => mainWindow, lastAccelerators, getLastStatus());
	await createMainWindow();
	if (mainWindow !== null) {
		if (isDevelopment) {
			// Wire the dev console helper (window.__zuseUpdateDemo) to a real
			// IPC round-trip so the banner can be exercised without a release.
			registerUpdaterDemo(mainWindow);
		} else {
			startAutoUpdater(mainWindow);
		}
	}

	app.on("activate", () => {
		if (mainWindow === null) {
			void createMainWindow();
		}
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

// ---------------------------------------------------------------------------
// Quit guard. Agents (Claude/Codex/Grok/… turns) run as child processes owned
// by the embedded server. Quitting mid-turn kills them, so if any are running
// we confirm first. The renderer store is the source of truth for "how many
// are running"; it pushes the count here on every change (see preload
// `updates.reportRunningCount`). We mirror the latest value so the
// synchronous `before-quit` handler can read it without a round-trip.
// ---------------------------------------------------------------------------
let runningAgentCount = 0;
// Set once the user has confirmed a quit (or an update install begins) so a
// re-entrant `before-quit` — Electron fires it again after `app.quit()` — does
// not pop the dialog a second time.
let quitConfirmed = false;
// Armed by the dialog's "Quit when idle" choice: keep running, then quit
// automatically the moment the last agent finishes.
let quitWhenIdle = false;

ipcMain.on(AGENTS_RUNNING_COUNT_CHANNEL, (_event, payload: unknown) => {
	runningAgentCount = typeof payload === "number" && payload >= 0 ? payload : 0;
	if (quitWhenIdle && runningAgentCount === 0) {
		quitConfirmed = true;
		app.quit();
	}
});

function pluralAgents(count: number): string {
	return count === 1 ? "1 agent is running" : `${count} agents are running`;
}

app.on("before-quit", (event) => {
	// An update-driven quit (user picked "Restart now") or an already-confirmed
	// quit passes straight through — the user has opted in, and re-prompting
	// would strand the relaunch.
	if (quitConfirmed || getIsInstallingUpdate()) return;
	if (runningAgentCount <= 0) return;

	event.preventDefault();

	const choice = dialog.showMessageBoxSync({
		type: "warning",
		buttons: ["Cancel", "Quit anyway", "Quit when idle"],
		defaultId: 0,
		cancelId: 0,
		title: "Quit Zuse Alpha?",
		message: `${pluralAgents(runningAgentCount)} currently.`,
		detail:
			"Quitting now will stop them mid-turn. You can quit anyway, or have Zuse quit automatically once they finish.",
	});

	if (choice === 1) {
		quitConfirmed = true;
		app.quit();
	} else if (choice === 2) {
		quitWhenIdle = true;
		// Stay open; the running-count handler quits once the count hits zero.
		// Guard against the race where every agent already finished between the
		// count push and this click.
		if (runningAgentCount === 0) {
			quitConfirmed = true;
			app.quit();
		}
	}
	// choice === 0 (Cancel): stay open — quit already prevented.
});

// Tear down the macOS notch tray once a quit actually proceeds. `will-quit`
// fires after an un-prevented `before-quit`, so a cancelled quit leaves the
// tray untouched.
app.on("will-quit", () => {
	localConnectivityStopping = true;
	if (localConnectivityRestartTimer !== null) {
		clearTimeout(localConnectivityRestartTimer);
		localConnectivityRestartTimer = null;
	}
	localConnectivityHelper?.kill("SIGTERM");
	localConnectivityHelper = null;
	notchTray?.destroy();
	notchTray = null;
});
