import { spawn } from "node:child_process";
import {
	chmod,
	chown,
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";

const ROOT = "/run/zuse-review-checks";
const userEnv = (cwd) => ({
	PATH: `${cwd}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin`,
	HOME: `${ROOT}/home`,
	CI: "true",
	LANG: "C.UTF-8",
	npm_config_ignore_scripts: "true",
	npm_config_audit: "false",
	npm_config_fund: "false",
	npm_config_userconfig: "/dev/null",
	npm_config_globalconfig: "/dev/null",
	npm_config_cache: `${ROOT}/cache`,
	BUN_INSTALL_CACHE_DIR: `${ROOT}/bun-cache`,
});
async function status(value) {
	await writeFile(`${ROOT}/status.tmp`, JSON.stringify(value), { mode: 0o600 });
	await rename(`${ROOT}/status.tmp`, `${ROOT}/status.json`);
}
async function exists(path) {
	try {
		return await lstat(path);
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}
async function assign(path, bounds = { entries: 0 }) {
	if (++bounds.entries > 50000) throw new Error("checkout-entry-limit");
	const meta = await lstat(path);
	if (meta.isSymbolicLink()) throw new Error("symlinks-not-supported");
	await chown(path, 1001, 1001);
	if (meta.isDirectory())
		for (const name of await readdir(path)) {
			if ([".npmrc", "bunfig.toml", ".bunfig.toml"].includes(name))
				throw new Error("repository-package-manager-config-not-supported");
			await assign(join(path, name), bounds);
		}
}

/** Root writes evidence; child output never controls status-file paths or commands. */
export function executeCheck(
	command,
	args,
	cwd,
	deadlineMs,
	env = userEnv(cwd),
	uid = 1001,
) {
	return new Promise((resolve) => {
		if (deadlineMs <= Date.now()) {
			resolve({ status: "timeout", output: "" });
			return;
		}
		const child = spawn(command, args, {
			cwd,
			env,
			uid,
			gid: uid,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let timedOut = false;
		const capture = (chunk) => {
			if (output.length < 8000)
				output = (output + chunk.toString("utf8")).slice(0, 8000);
		};
		child.stdout.on("data", capture);
		child.stderr.on("data", capture);
		const kill = () => {
			if (child.pid)
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch (error) {
					if (error.code !== "ESRCH") throw error;
				}
		};
		const timer = setTimeout(
			() => {
				timedOut = true;
				kill();
			},
			Math.max(1, deadlineMs - Date.now()),
		);
		child.once("error", () => {
			clearTimeout(timer);
			resolve({ status: "inconclusive", output: "command-unavailable" });
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			kill();
			resolve({
				status: timedOut ? "timeout" : code === 0 ? "passed" : "failed",
				...(code !== null ? { exitCode: code } : {}),
				output,
			});
		});
	});
}

const registryVersion = (value) =>
	typeof value === "string" && /^[A-Za-z0-9~^<>=*| .+-]+$/u.test(value);
const safePackage = (value) =>
	/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(value);
const safeWorkspace = (value) =>
	typeof value === "string" &&
	value.length <= 512 &&
	value
		.split("/")
		.every(
			(segment) =>
				segment === "*" ||
				(/^[A-Za-z0-9_@.-]+$/u.test(segment) &&
					segment !== "." &&
					segment !== ".."),
		);
async function readManifest(path) {
	for (const name of [".npmrc", "bunfig.toml", ".bunfig.toml"])
		if (await exists(join(path, name)))
			throw new Error("repository-package-manager-config-not-supported");
	const file = await exists(join(path, "package.json"));
	if (!file) return null;
	if (!file.isFile() || file.isSymbolicLink() || file.size > 1_000_000)
		throw new Error("invalid-package-manifest");
	return JSON.parse(await readFile(join(path, "package.json"), "utf8"));
}
/** Only declared in-checkout workspaces; no arbitrary local dependency links. */
export async function packageInfo(cwd) {
	const manifest = await readManifest(cwd);
	if (!manifest) return null;
	const patterns = Array.isArray(manifest.workspaces)
		? manifest.workspaces
		: (manifest.workspaces?.packages ?? []);
	if (!Array.isArray(patterns) || patterns.length > 100)
		throw new Error("invalid-workspaces");
	const paths = new Set();
	for (const pattern of patterns) {
		if (!safeWorkspace(pattern)) throw new Error("invalid-workspace-path");
		let matches = [""];
		for (const segment of pattern.split("/")) {
			const next = [];
			for (const parent of matches) {
				if (segment === "*") {
					for (const entry of await readdir(join(cwd, parent), {
						withFileTypes: true,
					})) {
						if (entry.isSymbolicLink())
							throw new Error("symlinks-not-supported");
						if (entry.isDirectory())
							next.push(parent ? `${parent}/${entry.name}` : entry.name);
					}
				} else {
					const meta = await exists(join(cwd, parent, segment));
					if (meta?.isSymbolicLink()) throw new Error("symlinks-not-supported");
					if (meta?.isDirectory())
						next.push(parent ? `${parent}/${segment}` : segment);
				}
			}
			if (next.length > 500) throw new Error("workspace-limit");
			matches = next;
		}
		for (const path of matches)
			if (await readManifest(join(cwd, path))) paths.add(path);
	}
	if (paths.size > 500) throw new Error("workspace-limit");
	const manifests = [manifest];
	for (const path of paths) manifests.push(await readManifest(join(cwd, path)));
	const names = new Set(
		manifests
			.map((value) => value?.name)
			.filter((value) => typeof value === "string"),
	);
	const catalog = manifest.workspaces?.catalog ?? manifest.catalog ?? {};
	const catalogs = manifest.workspaces?.catalogs ?? manifest.catalogs ?? {};
	const validate = (name, value) => {
		if (!safePackage(name) || typeof value !== "string")
			throw new Error("invalid-dependency");
		if (value.startsWith("workspace:")) {
			if (!names.has(name) || !/^[*^~0-9.-]+$/u.test(value.slice(10)))
				throw new Error("invalid-workspace-dependency");
			return;
		}
		if (value.startsWith("catalog:")) {
			const key = value.slice(8);
			if (!registryVersion((key ? catalogs[key] : catalog)?.[name]))
				throw new Error("invalid-catalog-dependency");
			return;
		}
		if (value.startsWith("npm:")) {
			const separator = value.lastIndexOf("@");
			if (
				separator <= 4 ||
				!safePackage(value.slice(4, separator)) ||
				!registryVersion(value.slice(separator + 1))
			)
				throw new Error("invalid-registry-alias");
			return;
		}
		if (!registryVersion(value))
			throw new Error("non-registry-dependency-not-supported");
	};
	for (const item of manifests) {
		for (const group of [
			"dependencies",
			"devDependencies",
			"optionalDependencies",
			"peerDependencies",
		])
			for (const [name, value] of Object.entries(item?.[group] ?? {}))
				validate(name, value);
	}
	return { ...manifest, reviewWorkspacePaths: paths };
}
function registryUrl(value) {
	try {
		const url = new URL(value);
		return (
			["https:", "http:"].includes(url.protocol) &&
			url.hostname === "registry.npmjs.org" &&
			!url.port &&
			!url.username &&
			!url.password
		);
	} catch {
		return false;
	}
}
export function validateBunLock(text, workspacePaths) {
	const errors = [];
	const lock = parseJsonc(text, errors, { allowTrailingComma: true });
	if (
		errors.length ||
		!lock ||
		typeof lock.packages !== "object" ||
		lock.packages === null
	)
		throw new Error("invalid-bun-lock");
	for (const tuple of Object.values(lock.packages)) {
		if (!Array.isArray(tuple) || typeof tuple[0] !== "string")
			throw new Error("invalid-bun-lock-entry");
		const workspace = tuple[0].indexOf("@workspace:");
		if (workspace >= 0) {
			if (!workspacePaths.has(tuple[0].slice(workspace + 11)))
				throw new Error("external-workspace-lock");
			continue;
		}
		const separator = tuple[0].lastIndexOf("@");
		if (
			separator < 1 ||
			!safePackage(tuple[0].slice(0, separator)) ||
			!registryVersion(tuple[0].slice(separator + 1)) ||
			(tuple[1] !== "" && !registryUrl(tuple[1])) ||
			typeof tuple[3] !== "string" ||
			!/^sha(?:1|256|512)-[A-Za-z0-9+/=]+$/u.test(tuple[3])
		)
			throw new Error("non-registry-lockfile-not-supported");
	}
}
async function install(cwd, deadlineMs) {
	const manifest = await packageInfo(cwd);
	if (!manifest) return;
	let command;
	let args;
	if (await exists(join(cwd, "package-lock.json"))) {
		const lock = await readFile(join(cwd, "package-lock.json"), "utf8");
		if (Buffer.byteLength(lock) > 20_000_000)
			throw new Error("lockfile-too-large");
		const inspect = (value) => {
			if (!value || typeof value !== "object") return;
			for (const [key, entry] of Object.entries(value)) {
				if (
					key === "resolved" &&
					(typeof entry !== "string" ||
						!entry.startsWith("https://registry.npmjs.org/"))
				)
					throw new Error("non-registry-lockfile-not-supported");
				inspect(entry);
			}
		};
		inspect(JSON.parse(lock));
		command = "/usr/local/bin/npm";
		args = ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];
	} else if (await exists(join(cwd, "bun.lock"))) {
		// A text lock is inspectable; binary lockfiles cannot be screened here.
		const lock = await readFile(join(cwd, "bun.lock"), "utf8");
		if (Buffer.byteLength(lock) > 20_000_000)
			throw new Error("lockfile-too-large");
		validateBunLock(lock, manifest.reviewWorkspacePaths);
		command = "/usr/local/bin/bun";
		args = ["install", "--frozen-lockfile", "--ignore-scripts"];
	} else if (await exists(join(cwd, "bun.lockb")))
		throw new Error("binary-lockfile-not-supported");
	else return;
	const result = await executeCheck(
		command,
		args,
		cwd,
		Math.min(deadlineMs - 5000, Date.now() + 60_000),
	);
	if (result.status !== "passed")
		throw new Error("dependency-install-inconclusive");
}

export async function prepareChecks(input, token) {
	if (!token || token.length > 4096)
		throw new Error("missing-clone-authorization");
	await mkdir(ROOT, { mode: 0o711 });
	await chmod(ROOT, 0o711);
	for (const name of ["home", "cache", "bun-cache"]) {
		await mkdir(join(ROOT, name), { mode: 0o700 });
		await chown(join(ROOT, name), 1001, 1001);
	}
	const repo = join(ROOT, "git");
	await mkdir(repo, { mode: 0o700 });
	const gitEnv = {
		PATH: "/usr/bin:/bin",
		HOME: ROOT,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_NO_REPLACE_OBJECTS: "1",
	};
	const git = async (args, secret) => {
		const env = {
			...gitEnv,
			...(secret
				? {
						GIT_CONFIG_COUNT: "1",
						GIT_CONFIG_KEY_0: "http.extraHeader",
						GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${secret}`).toString("base64")}`,
					}
				: {}),
		};
		const result = await executeCheck(
			"/usr/bin/git",
			["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
			repo,
			Math.min(input.deadlineMs - 5000, Date.now() + 60_000),
			env,
			0,
		);
		if (result.status !== "passed")
			throw new Error("immutable-checkout-unavailable");
	};
	await git(["init", "--bare", repo]);
	await git(
		[
			"fetch",
			"--no-tags",
			"--no-recurse-submodules",
			input.cloneUrl,
			input.baseSha,
			input.headSha,
		],
		token,
	);
	token = "";
	for (const [side, sha] of [
		["base", input.baseSha],
		["head", input.headSha],
	]) {
		const cwd = join(ROOT, side);
		await git(["worktree", "add", "--detach", cwd, sha]);
		await rm(join(cwd, ".git"));
		await assign(cwd);
	}
	const base = await packageInfo(join(ROOT, "base"));
	const checks = ["test", "typecheck", "check-types"].flatMap((script) => {
		const command = base?.scripts?.[script];
		return typeof command === "string" &&
			command.trim() &&
			command.length <= 2000
			? [{ script, command }]
			: [];
	});
	await writeFile(
		join(ROOT, "plan.json"),
		JSON.stringify({
			checks,
			baseSha: input.baseSha,
			headSha: input.headSha,
			deadlineMs: input.deadlineMs,
		}),
		{ mode: 0o600 },
	);
	if (checks.length) {
		await install(join(ROOT, "base"), input.deadlineMs);
		await install(join(ROOT, "head"), input.deadlineMs);
	}
	await status({
		phase: "prepared",
		...(checks.length ? {} : { reason: "not_available" }),
	});
}

export async function runChecks(input) {
	try {
		await mkdir(`${ROOT}/run-lock`, { mode: 0o700 });
	} catch (error) {
		if (error.code === "EEXIST") return;
		throw error;
	}
	const plan = JSON.parse(await readFile(join(ROOT, "plan.json"), "utf8"));
	if (
		plan.baseSha !== input.baseSha ||
		plan.headSha !== input.headSha ||
		plan.deadlineMs !== input.deadlineMs
	)
		throw new Error("check-snapshot-mismatch");
	const checks = [];
	for (const check of plan.checks) {
		const pair = {};
		for (const side of ["base", "head"])
			pair[side] = await executeCheck(
				"/bin/sh",
				["-c", check.command],
				join(ROOT, side),
				Math.min(input.deadlineMs - 5000, Date.now() + 30_000),
			);
		checks.push({ ...check, ...pair });
	}
	await status({
		phase: "complete",
		checks,
		...(!checks.length ? { reason: "not_available" } : {}),
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		if (process.getuid() !== 0) throw new Error("root-supervisor-required");
		const input = JSON.parse(process.argv[3] ?? "{}");
		if (
			!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/u.test(
				input.cloneUrl,
			) ||
			!/^[a-f0-9]{40}$/u.test(input.baseSha) ||
			!/^[a-f0-9]{40}$/u.test(input.headSha) ||
			!Number.isSafeInteger(input.deadlineMs) ||
			input.deadlineMs <= Date.now() ||
			input.deadlineMs > Date.now() + 600_000
		)
			throw new Error("invalid-check-request");
		const token = process.env.ZUSE_REVIEW_GIT_TOKEN;
		delete process.env.ZUSE_REVIEW_GIT_TOKEN;
		if (process.argv[2] === "prepare") await prepareChecks(input, token);
		else if (process.argv[2] === "run") await runChecks(input);
		else throw new Error("invalid-check-operation");
	} catch {
		await status({ phase: "failed", reason: "checks-inconclusive" }).catch(
			() => {},
		);
		process.exitCode = 1;
	}
}
