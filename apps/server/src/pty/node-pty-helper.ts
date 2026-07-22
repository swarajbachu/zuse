import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
let helperReady = false;

const unpackedPath = (path: string): string =>
	path
		.replace("app.asar", "app.asar.unpacked")
		.replace("node_modules.asar", "node_modules.asar.unpacked");

export const ensureExecutableFile = (path: string): void => {
	const mode = statSync(path).mode;
	if ((mode & 0o111) === 0) chmodSync(path, mode | 0o111);
};

/**
 * Bun can install node-pty's prebuilt spawn helper without its executable bit.
 * The native addon then loads normally, but every PTY fails with
 * `posix_spawnp failed`. Repair only node-pty's resolved helper before spawn.
 */
export const ensureNodePtySpawnHelperExecutable = (): void => {
	if (helperReady || process.platform === "win32") return;

	const packageRoot = dirname(dirname(require.resolve("node-pty")));
	const candidates = [
		join(packageRoot, "build", "Release", "spawn-helper"),
		join(packageRoot, "build", "Debug", "spawn-helper"),
		join(
			packageRoot,
			"prebuilds",
			`${process.platform}-${process.arch}`,
			"spawn-helper",
		),
	].map(unpackedPath);
	const helper = candidates.find(existsSync);
	if (helper === undefined) return;

	ensureExecutableFile(helper);
	helperReady = true;
};
