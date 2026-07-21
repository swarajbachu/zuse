import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(desktopRoot, "native", "local-connectivity", "main.swift");
const outputDirectory = join(
	desktopRoot,
	"native",
	"local-connectivity",
	"bin",
);
const output = join(outputDirectory, "zuse-local-connectivity");
mkdirSync(outputDirectory, { recursive: true });
const moduleCache = join(outputDirectory, "module-cache");
mkdirSync(moduleCache, { recursive: true });

const run = (command, args) => {
	const result = spawnSync(command, args, {
		stdio: "inherit",
		env: {
			...process.env,
			CLANG_MODULE_CACHE_PATH: moduleCache,
			SWIFT_MODULECACHE_PATH: moduleCache,
		},
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
};

if (process.argv.includes("--universal")) {
	const arm = `${output}.arm64`;
	const intel = `${output}.x86_64`;
	run("xcrun", [
		"swiftc",
		"-O",
		"-target",
		"arm64-apple-macos13",
		source,
		"-o",
		arm,
	]);
	run("xcrun", [
		"swiftc",
		"-O",
		"-target",
		"x86_64-apple-macos13",
		source,
		"-o",
		intel,
	]);
	run("xcrun", ["lipo", "-create", arm, intel, "-output", output]);
} else {
	run("xcrun", ["swiftc", source, "-o", output]);
}
