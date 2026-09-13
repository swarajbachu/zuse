import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright-core";
import { closeElectronApplication } from "../src/electron-app.ts";

const imageArgument = process.argv[2];
if (!imageArgument) throw new Error("Expected an AppImage path");
const image = resolve(imageArgument);
const root = await mkdtemp(join(tmpdir(), "zuse-packaged-smoke-"));
const userData = join(root, "profile");
const appDir = join(root, "squashfs-root");
const metadata = process.env.RELEASE_METADATA
	? JSON.parse(await readFile(process.env.RELEASE_METADATA, "utf8"))
	: undefined;
try {
	await chmod(image, 0o755);
	execFileSync(image, ["--appimage-extract"], {
		cwd: root,
		stdio: "ignore",
		timeout: 60_000,
	});
	for (const expectedChannel of ["stable", "preview"]) {
		const app = await _electron.launch({
			executablePath: join(appDir, "AppRun"),
			// Cloud runners can have only 64 MiB of /dev/shm. Keep Chromium IPC
			// storage in /tmp for this headless artifact check.
			args: [
				"--no-sandbox",
				"--disable-gpu",
				"--disable-dev-shm-usage",
				"--use-mock-keychain",
			],
			env: {
				...process.env,
				APPIMAGE: image,
				APPDIR: appDir,
				ZUSE_USER_DATA_DIR: userData,
				ZUSE_DISABLE_DEEP_ENERGY_PROFILE: "1",
			},
		});
		try {
			const page = await app.firstWindow();
			await page.waitForFunction(
				() =>
					document.body.textContent?.includes("Get started") ||
					document.body.textContent?.includes("Zuse hit a UI error."),
				undefined,
				{ timeout: 30_000 },
			);
			assert.equal(
				await page
					.getByRole("button", { name: "Get started", exact: true })
					.isVisible(),
				true,
				await page.locator("body").innerText(),
			);
			const version = await app.evaluate(({ app }) => app.getVersion());
			assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
			if (metadata) assert.equal(version, metadata.version);
			assert.equal(
				await page.evaluate("window.zuse.updates.getChannel()"),
				expectedChannel,
			);
			if (expectedChannel === "stable") {
				assert.equal(
					await page.evaluate('window.zuse.updates.setChannel("preview")'),
					"preview",
				);
			}
			console.log(
				`Packaged ${version}: startup and ${expectedChannel} preference passed`,
			);
		} finally {
			await closeElectronApplication(app);
		}
	}
} finally {
	await rm(root, { recursive: true, force: true });
}
