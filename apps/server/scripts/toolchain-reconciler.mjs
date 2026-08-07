#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	lstat,
	mkdir,
	readFile,
	readlink,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const manifestFile =
	process.argv[2] ??
	join(dirname(new URL(import.meta.url).pathname), "toolchain-manifest.json");
const toolchainsRoot =
	process.env.ZUSE_TOOLCHAINS_ROOT ?? "/opt/zuse/toolchains";
const currentLink =
	process.env.ZUSE_TOOLCHAIN_CURRENT_LINK ?? "/opt/zuse/toolchain-current";
const skipSystemPackages =
	process.env.ZUSE_TOOLCHAIN_SKIP_SYSTEM_PACKAGES === "1";
const skipInstall = process.env.ZUSE_TOOLCHAIN_SKIP_INSTALL === "1";

const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
const safeSystemPackage = /^[a-z0-9][a-z0-9+.-]*$/u;
const safeNpmPackage = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const safeVersion = /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][a-z0-9.-]+)?$/u;
if (
	manifest.schemaVersion !== 1 ||
	manifest.architecture !== "linux-x64" ||
	typeof manifest.version !== "string" ||
	!safeVersion.test(manifest.version) ||
	!Array.isArray(manifest.systemPackages) ||
	manifest.systemPackages.some(
		(name) => typeof name !== "string" || !safeSystemPackage.test(name),
	) ||
	typeof manifest.npmPackages !== "object" ||
	manifest.npmPackages === null ||
	Object.entries(manifest.npmPackages).some(
		([name, version]) =>
			!safeNpmPackage.test(name) ||
			typeof version !== "string" ||
			!safeVersion.test(version),
	)
) {
	throw new Error("Toolchain manifest is invalid");
}

const run = (command, args, options = {}) =>
	new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
			env: process.env,
		});
		let output = "";
		if (options.capture) {
			child.stdout.on("data", (chunk) => {
				output += chunk.toString();
			});
			child.stderr.on("data", (chunk) => {
				output += chunk.toString();
			});
		}
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve(output.trim());
			else reject(new Error(`${command} exited with ${code ?? "unknown"}`));
		});
	});

if (!skipSystemPackages) {
	await run("apt-get", ["update"]);
	await run("apt-get", [
		"install",
		"-y",
		"--no-install-recommends",
		...manifest.systemPackages,
	]);
	await run("git", ["lfs", "install", "--system"]);
	try {
		await lstat("/usr/local/bin/fd");
	} catch {
		await symlink("/usr/bin/fdfind", "/usr/local/bin/fd");
	}
}

await mkdir(toolchainsRoot, { recursive: true, mode: 0o755 });
const release = join(toolchainsRoot, manifest.version);
const staging = `${release}.staging-${randomUUID()}`;
let releaseReady = false;
try {
	const installedManifest = JSON.parse(
		await readFile(join(release, "zuse-toolchain.json"), "utf8"),
	);
	if (JSON.stringify(installedManifest) !== JSON.stringify(manifest)) {
		throw new Error("Toolchain version was reused with different contents");
	}
	releaseReady = true;
} catch (cause) {
	if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) {
		throw cause;
	}
}
if (skipInstall && !releaseReady) {
	throw new Error("Requested toolchain release is not installed");
}
if (!skipInstall && !releaseReady) {
	await mkdir(staging, { recursive: true, mode: 0o755 });
	const packageSpecs = Object.entries(manifest.npmPackages).map(
		([name, version]) => `${name}@${version}`,
	);
	await run("/usr/local/bin/npm", [
		"install",
		"--no-audit",
		"--no-fund",
		"--omit=dev",
		"--prefix",
		staging,
		...packageSpecs,
	]);
	await writeFile(
		join(staging, "zuse-toolchain.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
		{ mode: 0o644 },
	);
	try {
		await rename(staging, release);
	} catch (cause) {
		if (
			cause instanceof Error &&
			"code" in cause &&
			(cause.code === "EEXIST" || cause.code === "ENOTEMPTY")
		) {
			await rm(staging, { recursive: true, force: true });
		} else {
			throw cause;
		}
	}
}

let previousTarget;
try {
	previousTarget = await readlink(currentLink);
} catch {
	previousTarget = undefined;
}
const nextLink = `${currentLink}.next-${randomUUID()}`;
await symlink(release, nextLink);
await rename(nextLink, currentLink);

const bin = (name) => join(currentLink, "node_modules", ".bin", name);
const expected = [
	[bin("bun"), ["--version"], manifest.npmPackages.bun],
	[bin("corepack"), ["--version"], manifest.npmPackages.corepack],
	[
		bin("claude"),
		["--version"],
		manifest.npmPackages["@anthropic-ai/claude-code"],
	],
	[bin("codex"), ["--version"], manifest.npmPackages["@openai/codex"]],
];
try {
	for (const [command, args, version] of expected) {
		const output = await run(command, args, { capture: true });
		if (!output.includes(version)) {
			throw new Error(`${command} did not report the pinned version`);
		}
	}
	for (const [command, args] of [
		["git", ["--version"]],
		["gh", ["--version"]],
		["git-lfs", ["--version"]],
		["ssh", ["-V"]],
		["tmux", ["-V"]],
		["rg", ["--version"]],
		["fd", ["--version"]],
		["jq", ["--version"]],
		["python3", ["--version"]],
	]) {
		await run(command, args, { capture: true });
	}
} catch (cause) {
	if (previousTarget === undefined) await rm(currentLink, { force: true });
	else {
		const rollbackLink = `${currentLink}.rollback-${randomUUID()}`;
		await symlink(previousTarget, rollbackLink);
		await rename(rollbackLink, currentLink);
	}
	throw cause;
}

for (const name of ["bun", "corepack", "claude", "codex"]) {
	const destination = `/usr/local/bin/${name}`;
	const temporary = `${destination}.next-${randomUUID()}`;
	await symlink(bin(name), temporary);
	await rename(temporary, destination);
}

console.log(`Reconciled Zuse developer toolchain ${manifest.version}`);
