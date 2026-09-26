import {
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	keytarShimRequirePath,
	makeBoundedTextBuffer,
	makeHermeticEnvironment,
} from "@zuse/testkit";
import {
	_electron,
	type ElectronApplication,
	type Page,
} from "playwright-core";

const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const requireFromDesktop = createRequire(
	join(repoRoot, "apps/desktop/package.json"),
);

export type ElectronHarness = {
	readonly app: ElectronApplication;
	readonly page: Page;
	readonly errors: ReadonlyArray<string>;
	readonly diagnostics: () => string;
	readonly captureFailure: (name: string) => Promise<string>;
	readonly close: () => Promise<void>;
};

export const closeElectronApplication = async (
	app: ElectronApplication,
): Promise<void> => {
	const child = app.process();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const graceful = app
		.close()
		.then(() => true)
		.catch(() => true);
	const closed = await Promise.race([
		graceful,
		new Promise<false>((resolve) => {
			timeout = setTimeout(() => resolve(false), 3_000);
		}),
	]);
	if (timeout !== undefined) clearTimeout(timeout);
	if (closed || child.exitCode !== null || child.signalCode !== null) return;

	// Playwright can hang while closing a wedged renderer. Terminate only the
	// child launched by this harness so a failed desktop test cannot leave its
	// isolated app and provider processes behind.
	child.kill("SIGTERM");
	await Promise.race([
		new Promise<void>((resolve) => child.once("exit", () => resolve())),
		new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
	]);
	if (child.exitCode === null && child.signalCode === null)
		child.kill("SIGKILL");
};

const readAppDiagnostics = (userData: string): string => {
	const logDirectory = join(userData, "logs");
	const output = makeBoundedTextBuffer(256 * 1024);
	let entries: string[];
	try {
		entries = readdirSync(logDirectory, {
			encoding: "utf8",
			recursive: true,
		}).sort();
	} catch {
		return "(no app log directory)";
	}
	for (const relativePath of entries) {
		const absolutePath = join(logDirectory, relativePath);
		try {
			if (!statSync(absolutePath).isFile()) continue;
			const contents = readFileSync(absolutePath, "utf8");
			output.append(
				`\n--- ${relativePath} ---\n${contents.slice(-64 * 1024)}\n`,
			);
		} catch {
			// A diagnostic file can rotate while the failure artifact is captured.
		}
	}
	return output.read();
};

export const launchElectronApp = async (options: {
	readonly root: string;
	readonly userData: string;
	readonly providerBinDirectory: string;
	readonly providerEnvironment?: Readonly<Record<string, string>>;
}): Promise<ElectronHarness> => {
	const errors: Array<string> = [];
	const stdout = makeBoundedTextBuffer(64 * 1024);
	const stderr = makeBoundedTextBuffer(64 * 1024);
	const pushError = (error: string): void => {
		errors.push(error.slice(-4 * 1024));
		if (errors.length > 128) errors.shift();
	};
	const executablePath = requireFromDesktop("electron") as string;
	const app = await _electron.launch({
		executablePath,
		// A fresh macOS user-data directory has no Chromium encryption key. The
		// automation-only mock keychain prevents Electron from opening a native
		// "Keychain Not Found" dialog while preserving isolated browser state.
		args: [
			"--use-mock-keychain",
			// Headless Linux runners have no usable hardware GL context. Use the
			// bundled software renderer for UI surfaces that require WebGL.
			...(process.platform === "linux"
				? [
						"--use-gl=angle",
						"--use-angle=swiftshader",
						"--enable-unsafe-swiftshader",
					]
				: []),
			join(repoRoot, "apps/desktop/dist-electron/main.cjs"),
		],
		cwd: repoRoot,
		env: makeHermeticEnvironment({
			HOME: join(options.root, "home"),
			PATH: options.providerBinDirectory,
			...(process.env.DISPLAY === undefined
				? {}
				: { DISPLAY: process.env.DISPLAY }),
			...options.providerEnvironment,
			VITE_DEV_SERVER_URL: "",
			ZUSE_DESKTOP_WS_PORT: "0",
			NODE_OPTIONS: `--require=${keytarShimRequirePath}`,
			ZUSE_PRESERVE_PATH: "1",
			ZUSE_DISABLE_DEEP_ENERGY_PROFILE: "1",
			ZUSE_USER_DATA_DIR: options.userData,
			...options.providerEnvironment,
		}),
	});
	app.process().stdout?.on("data", (chunk) => {
		stdout.append(String(chunk));
	});
	app.process().stderr?.on("data", (chunk) => {
		stderr.append(String(chunk));
	});
	const observedPages = new WeakSet<Page>();
	const observePage = (page: Page): void => {
		if (observedPages.has(page)) return;
		observedPages.add(page);
		void page
			.context()
			.newCDPSession(page)
			.then(async (session) => {
				const requests = new Map<string, string>();
				session.on("Network.requestWillBeSent", (event) => {
					requests.set(event.requestId, event.request.url);
				});
				session.on("Network.loadingFinished", (event) => {
					requests.delete(event.requestId);
				});
				session.on("Network.loadingFailed", (event) => {
					const detail = [
						`type=${event.type}`,
						`canceled=${event.canceled === true}`,
						event.blockedReason === undefined
							? null
							: `blocked=${event.blockedReason}`,
						event.corsErrorStatus === undefined
							? null
							: `cors=${event.corsErrorStatus.corsError}`,
					]
						.filter((value) => value !== null)
						.join(" ");
					pushError(
						`CDP load failed: ${requests.get(event.requestId) ?? event.requestId} (${event.errorText}; ${detail})`,
					);
					requests.delete(event.requestId);
				});
				await session.send("Network.enable");
			})
			.catch(() => {});
		page.on("pageerror", (error) => pushError(error.stack ?? error.message));
		page.on("requestfailed", (request) => {
			pushError(
				`Request failed: ${request.url()} (${request.failure()?.errorText ?? "unknown error"})`,
			);
		});
		page.on("console", (message) => {
			if (message.type() === "error") {
				const location = message.location();
				const source = location.url
					? ` (${location.url}:${location.lineNumber}:${location.columnNumber})`
					: "";
				pushError(`${message.text()}${source}`);
			}
		});
	};
	app.on("window", observePage);
	let page: Page;
	try {
		page = await app.firstWindow({ timeout: 20_000 });
		observePage(page);
		await page.waitForLoadState("domcontentloaded");
	} catch (cause) {
		await closeElectronApplication(app);
		throw cause;
	}
	let closed = false;
	const diagnostics = () =>
		`renderer errors:\n${errors.join("\n")}\nmain stdout:\n${stdout.read()}\nmain stderr:\n${stderr.read()}\napp logs:\n${readAppDiagnostics(options.userData)}`;
	return {
		app,
		page,
		errors,
		diagnostics,
		captureFailure: async (name) => {
			const directory = join(repoRoot, ".context", "test-artifacts");
			mkdirSync(directory, { recursive: true });
			const safeName = name.replace(/[^a-z0-9_-]+/gi, "-");
			const prefix = join(directory, `${safeName}-${Date.now()}`);
			await page.screenshot({ path: `${prefix}.png`, fullPage: true });
			writeFileSync(`${prefix}.log`, diagnostics());
			return prefix;
		},
		close: async () => {
			if (closed) return;
			closed = true;
			await closeElectronApplication(app);
		},
	};
};
