import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (command, args, moduleCache) => {
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

const buildHelper = (directory, executable) => {
	const source = join(desktopRoot, "native", directory, "main.swift");
	const outputDirectory = join(desktopRoot, "native", directory, "bin");
	const output = join(outputDirectory, executable);
	mkdirSync(outputDirectory, { recursive: true });
	const moduleCache = join(outputDirectory, "module-cache");
	mkdirSync(moduleCache, { recursive: true });

	if (process.argv.includes("--universal")) {
		const arm = `${output}.arm64`;
		const intel = `${output}.x86_64`;
		for (const [target, targetOutput] of [
			["arm64-apple-macos13", arm],
			["x86_64-apple-macos13", intel],
		]) {
			run(
				"xcrun",
				["swiftc", "-O", "-target", target, source, "-o", targetOutput],
				moduleCache,
			);
		}
		run(
			"xcrun",
			["lipo", "-create", arm, intel, "-output", output],
			moduleCache,
		);
	} else {
		run("xcrun", ["swiftc", source, "-o", output], moduleCache);
	}
};

buildHelper("local-connectivity", "zuse-local-connectivity");
buildHelper("browser-credentials", "zuse-browser-credentials");
