import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeHermeticEnvironment } from "@zuse/testkit";
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

export const launchElectronApp = async (options: {
	readonly root: string;
	readonly userData: string;
	readonly providerBinDirectory: string;
}): Promise<ElectronHarness> => {
	const errors: Array<string> = [];
	let stdout = "";
	let stderr = "";
	const executablePath = requireFromDesktop("electron") as string;
	const app = await _electron.launch({
		executablePath,
		// A fresh macOS user-data directory has no Chromium encryption key. The
		// automation-only mock keychain prevents Electron from opening a native
		// "Keychain Not Found" dialog while preserving isolated browser state.
		args: [
			"--use-mock-keychain",
			join(repoRoot, "apps/desktop/dist-electron/main.cjs"),
		],
		cwd: repoRoot,
		env: makeHermeticEnvironment({
			HOME: join(options.root, "home"),
			PATH: options.providerBinDirectory,
			VITE_DEV_SERVER_URL: "",
			ZUSE_DESKTOP_WS_PORT: "0",
			ZUSE_CREDENTIAL_STORE: "ephemeral",
			ZUSE_PRESERVE_PATH: "1",
			ZUSE_USER_DATA_DIR: options.userData,
		}),
	});
	app.process().stdout?.on("data", (chunk) => {
		stdout += String(chunk);
	});
	app.process().stderr?.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const observedPages = new WeakSet<Page>();
	const observePage = (page: Page): void => {
		if (observedPages.has(page)) return;
		observedPages.add(page);
		page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
		page.on("console", (message) => {
			if (message.type() === "error") errors.push(message.text());
		});
	};
	app.on("window", observePage);
	let page: Page;
	try {
		page = await app.firstWindow({ timeout: 20_000 });
		observePage(page);
		await page.waitForLoadState("domcontentloaded");
	} catch (cause) {
		await app.close().catch(() => undefined);
		throw cause;
	}
	return {
		app,
		page,
		errors,
		diagnostics: () =>
			`renderer errors:\n${errors.join("\n")}\nmain stdout:\n${stdout}\nmain stderr:\n${stderr}`,
		captureFailure: async (name) => {
			const directory = join(repoRoot, ".context", "test-artifacts");
			mkdirSync(directory, { recursive: true });
			const safeName = name.replace(/[^a-z0-9_-]+/gi, "-");
			const prefix = join(directory, `${safeName}-${Date.now()}`);
			await page.screenshot({ path: `${prefix}.png`, fullPage: true });
			writeFileSync(
				`${prefix}.log`,
				`renderer errors:\n${errors.join("\n")}\nmain stdout:\n${stdout}\nmain stderr:\n${stderr}`,
			);
			return prefix;
		},
		close: async () => {
			await app.close();
		},
	};
};
