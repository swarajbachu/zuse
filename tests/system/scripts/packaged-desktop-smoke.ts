import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { cpus, freemem, release, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import {
	readEngineEndpoint,
	requestIdleEngineShutdown,
} from "@zusehq/server/desktop-engine";
import { _electron } from "playwright-core";
import { closeElectronApplication } from "../src/electron-app.ts";
import { waitForEngineEndpoint } from "../src/engine-readiness.ts";
import {
	descendantProcessTree,
	readProcessTreeSnapshot,
} from "../src/power-benchmark.ts";

const imageArgument = process.argv[2];
if (!imageArgument)
	throw new Error("Expected an AppImage or installed Windows executable path");
const image = resolve(imageArgument);
const root = await mkdtemp(join(tmpdir(), "zuse packaged ü-"));
const windows = process.platform === "win32";
const output = resolve(
	process.env.ZUSE_SMOKE_REPORT_DIR || ".context/windows/packaged",
);
if (windows) await mkdir(output, { recursive: true });
const userData = process.env.ZUSE_SMOKE_USER_DATA_DIR || join(root, "profile");
const appDir = join(root, "squashfs-root");
const metadata = process.env.RELEASE_METADATA
	? JSON.parse(await readFile(process.env.RELEASE_METADATA, "utf8"))
	: undefined;
try {
	if (!windows) {
		await chmod(image, 0o755);
		execFileSync(image, ["--appimage-extract"], {
			cwd: root,
			stdio: "ignore",
			timeout: 60_000,
		});
	}
	const runs = windows ? 10 : 2;
	for (let run = 0; run < runs; run++) {
		const expectedChannel =
			run === 0 && process.env.ZUSE_SMOKE_EXISTING_PROFILE !== "1"
				? "stable"
				: "preview";
		const startedAt = Date.now();
		const app = await _electron.launch({
			executablePath: windows ? image : join(appDir, "AppRun"),
			// Cloud runners can have only 64 MiB of /dev/shm. Keep Chromium IPC
			// storage in /tmp for this headless artifact check.
			args: windows
				? []
				: [
						"--no-sandbox",
						"--disable-gpu",
						"--disable-dev-shm-usage",
						"--use-mock-keychain",
					],
			env: {
				...process.env,
				...(!windows ? { APPIMAGE: image, APPDIR: appDir } : {}),
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
			if (windows) {
				const endpoint = await waitForEngineEndpoint(userData);
				const snapshot = await readProcessTreeSnapshot();
				const pids = new Set(
					descendantProcessTree(snapshot, app.process().pid ?? -1).map(
						(item) => item.pid,
					),
				);
				for (const item of descendantProcessTree(
					snapshot,
					endpoint?.supervisorPid ?? endpoint?.pid ?? -1,
				))
					pids.add(item.pid);
				const processes = snapshot.filter((item) => pids.has(item.pid));
				await writeFile(
					join(output, `launch-${run}.json`),
					JSON.stringify(
						{
							readyMs: Date.now() - startedAt,
							os: release(),
							cpuCount: cpus().length,
							totalMemoryBytes: totalmem(),
							freeMemoryBytes: freemem(),
							processes,
						},
						null,
						2,
					),
				);
			}
			console.log(
				`Packaged ${version}: startup and ${expectedChannel} preference passed`,
			);
		} catch (error) {
			if (windows) {
				const pages = app.windows();
				if (pages[0])
					await pages[0]
						.screenshot({ path: join(output, `failure-${run}.png`) })
						.catch(() => {});
			}
			throw error;
		} finally {
			await closeElectronApplication(app);
			if (windows) {
				const endpoint = await readEngineEndpoint(userData);
				if (endpoint)
					assert.equal(
						await requestIdleEngineShutdown(endpoint, { userData }),
						"stopped",
					);
			}
		}
	}
} finally {
	const endpoint = await readEngineEndpoint(userData);
	if (endpoint !== null)
		assert.equal(
			await requestIdleEngineShutdown(endpoint, { userData }),
			"stopped",
			"The packaged smoke test's engine must be idle before cleanup",
		);
	await rm(root, { recursive: true, force: true });
}
