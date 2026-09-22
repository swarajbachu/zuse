import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGhosttyBuildBootstrap } from "./lib/ghostty-build-bootstrap.mjs";

const repository = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const revision = readFileSync(
	path.join(repository, "native/libghostty-vt/VERSION"),
	"utf8",
).trim();
const zigVersion = "0.15.2";
const cache = path.join(homedir(), ".cache", "zuse", "ghostty");
const externalZig = process.env.ZUSE_GHOSTTY_ZIG;
const bootstrap = createGhosttyBuildBootstrap({
	cacheRoot: cache,
	revision,
	zigVersion,
	tempLabel: "wasm",
	externalZig,
});
const source = bootstrap.sourceRoot;
const zig = bootstrap.zigExecutable;
const output = path.join(
	repository,
	"apps/renderer/src/terminal/ghostty/vendor/ghostty-vt.wasm",
);
const callbackOutput = path.join(
	repository,
	"apps/renderer/src/terminal/ghostty/vendor/pty-callback.wasm",
);
const provenanceOutput = path.join(
	repository,
	"apps/renderer/src/terminal/ghostty/vendor/provenance.json",
);

function run(command, args, options = {}) {
	execFileSync(command, args, { stdio: "inherit", ...options });
}

function sha256(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const buildKey = revision.slice(0, 12);
const buildRoot = path.join("/tmp", `zuse-ghostty-wasm-output-${buildKey}`);
const localCache = path.join("/tmp", `zuse-ghostty-wasm-local-${buildKey}`);
const globalCache = path.join("/tmp", `zuse-ghostty-wasm-global-${buildKey}`);
const releaseBootstrap = bootstrap.prepare();
try {
	for (const directory of [buildRoot, localCache, globalCache]) {
		rmSync(directory, { recursive: true, force: true });
		mkdirSync(directory, { recursive: true });
	}
	run(
		zig,
		[
			"build",
			"--seed",
			"0",
			"-j1",
			"--cache-dir",
			localCache,
			"--global-cache-dir",
			globalCache,
			"-Demit-lib-vt",
			"-Dtarget=wasm32-freestanding",
			"-Doptimize=ReleaseSmall",
			"-Dstrip=true",
			`-Dlib-version-string=0.1.0-dev+${revision}`,
			"-p",
			buildRoot,
		],
		{ cwd: source },
	);
	await mkdir(path.dirname(output), { recursive: true });
	await cp(path.join(buildRoot, "bin", "ghostty-vt.wasm"), output);
	run(zig, [
		"build-exe",
		path.join(
			repository,
			"apps/renderer/src/terminal/ghostty/pty-callback.zig",
		),
		"-target",
		"wasm32-freestanding",
		"-O",
		"ReleaseSmall",
		"-fno-entry",
		"-rdynamic",
		"--cache-dir",
		localCache,
		"--global-cache-dir",
		globalCache,
		`-femit-bin=${callbackOutput}`,
	]);
} finally {
	rmSync(buildRoot, { recursive: true, force: true });
	rmSync(localCache, { recursive: true, force: true });
	rmSync(globalCache, { recursive: true, force: true });
	releaseBootstrap();
}

// Zig writes executable outputs by default. These are packaged data assets,
// so normalize their modes rather than leaking the build host's defaults.
chmodSync(output, 0o644);
chmodSync(callbackOutput, 0o644);

writeFileSync(
	provenanceOutput,
	`${JSON.stringify(
		{
			artifacts: {
				"ghostty-vt.wasm": sha256(output),
				"pty-callback.wasm": sha256(callbackOutput),
			},
			ghosttyRevision: revision,
			jobs: 1,
			optimize: "ReleaseSmall",
			schemaVersion: 1,
			seed: 0,
			target: "wasm32-freestanding",
			zigVersion,
		},
		null,
		"\t",
	)}\n`,
);

console.log(`Wrote ${path.relative(repository, output)}`);
console.log(`Wrote ${path.relative(repository, callbackOutput)}`);
console.log(`Wrote ${path.relative(repository, provenanceOutput)}`);
