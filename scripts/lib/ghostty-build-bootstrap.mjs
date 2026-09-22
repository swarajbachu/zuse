import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

const GHOSTTY_REPOSITORY = "https://github.com/ghostty-org/ghostty.git";
const BOOTSTRAP_LOCK_STALE_MS = 15 * 60 * 1_000;
const ZIG_DISTRIBUTION_SHA256 = new Map([
	[
		"aarch64-linux",
		"958ed7d1e00d0ea76590d27666efbf7a932281b3d7ba0c6b01b0ff26498f667f",
	],
	[
		"x86_64-linux",
		"02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239",
	],
	[
		"aarch64-macos",
		"3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b",
	],
	[
		"x86_64-macos",
		"375b6909fc1495d16fc2c7db9538f707456bfc3373b14ee83fdd3e22b3d43f7f",
	],
]);

const run = (command, args, options = {}) =>
	execFileSync(command, args, { stdio: "inherit", ...options });

const outputOf = (command, args, options = {}) =>
	execFileSync(command, args, { encoding: "utf8", ...options }).trim();

const sha256 = (file) =>
	createHash("sha256").update(readFileSync(file)).digest("hex");

const ZIG_INTEGRITY_RECORD = "ZUSE-INTEGRITY.json";

const zigDistributionDigest = (root) => {
	const hash = createHash("sha256");
	const visit = (directory, relativeDirectory) => {
		const entries = readdirSync(directory, { withFileTypes: true }).sort(
			(left, right) => left.name.localeCompare(right.name, "en"),
		);
		for (const entry of entries) {
			if (relativeDirectory === "" && entry.name === ZIG_INTEGRITY_RECORD) {
				continue;
			}
			const relative =
				relativeDirectory === ""
					? entry.name
					: `${relativeDirectory}/${entry.name}`;
			const absolute = path.join(directory, entry.name);
			const metadata = lstatSync(absolute);
			const mode = (metadata.mode & 0o7777).toString(8);
			if (entry.isDirectory()) {
				hash.update(`directory\0${relative}\0${mode}\0`);
				visit(absolute, relative);
				continue;
			}
			if (entry.isFile()) {
				hash.update(
					`file\0${relative}\0${mode}\0${metadata.size}\0${sha256(absolute)}\0`,
				);
				continue;
			}
			if (entry.isSymbolicLink()) {
				hash.update(
					`symlink\0${relative}\0${mode}\0${readlinkSync(absolute)}\0`,
				);
				continue;
			}
			throw new Error(`Unsupported entry in Zig distribution: ${absolute}`);
		}
	};
	visit(root, "");
	return hash.digest("hex");
};

export const assertMatchingZigDistribution = ({ cachedRoot, verifiedRoot }) => {
	if (
		zigDistributionDigest(cachedRoot) !== zigDistributionDigest(verifiedRoot)
	) {
		throw new Error(
			`Cached Zig tree does not match the complete verified distribution: ${cachedRoot}`,
		);
	}
};

const assertCleanSource = (sourceRoot) => {
	const status = outputOf("git", ["-C", sourceRoot, "status", "--porcelain"]);
	if (status !== "") {
		throw new Error(`Cached Ghostty source has local changes: ${sourceRoot}`);
	}
};

export const assertMatchingExternalZig = ({
	externalZig,
	cachedZig,
	zigDistribution,
	zigVersion,
}) => {
	const externalVersion = outputOf(externalZig, ["version"]);
	if (externalVersion !== zigVersion) {
		throw new Error(`Expected Zig ${zigVersion}, found ${externalVersion}`);
	}
	if (sha256(externalZig) !== sha256(cachedZig)) {
		throw new Error(
			`ZUSE_GHOSTTY_ZIG does not match verified ${zigDistribution}`,
		);
	}
};

const processIsAlive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		return cause?.code === "EPERM";
	}
};

const readLockOwner = (lockPath) => {
	try {
		return JSON.parse(readFileSync(lockPath, "utf8"));
	} catch {
		return null;
	}
};

const acquireBootstrapLock = (cacheRoot) => {
	mkdirSync(cacheRoot, { recursive: true });
	const lockPath = path.join(cacheRoot, "ZUSE-BOOTSTRAP.lock");
	const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const owner = {
		hostname: hostname(),
		pid: process.pid,
		startedAt: Date.now(),
		token,
	};
	for (let attempt = 0; attempt < 3; attempt += 1) {
		let created = false;
		try {
			const descriptor = openSync(lockPath, "wx", 0o600);
			created = true;
			try {
				writeFileSync(descriptor, `${JSON.stringify(owner)}\n`);
			} finally {
				closeSync(descriptor);
			}
			return () => {
				const current = readLockOwner(lockPath);
				if (current?.token === token) rmSync(lockPath, { force: true });
			};
		} catch (cause) {
			if (created) {
				rmSync(lockPath, { force: true });
				throw cause;
			}
			if (cause?.code !== "EEXIST") throw cause;
		}

		const current = readLockOwner(lockPath);
		let age = 0;
		try {
			age = Date.now() - statSync(lockPath).mtimeMs;
		} catch (cause) {
			if (cause?.code === "ENOENT") continue;
			throw cause;
		}
		const hasLocalProcessOwner =
			current?.hostname === hostname() &&
			Number.isSafeInteger(current.pid) &&
			current.pid > 0;
		const ownedByDeadLocalProcess =
			hasLocalProcessOwner && !processIsAlive(current.pid);
		const staleByAge = !hasLocalProcessOwner && age > BOOTSTRAP_LOCK_STALE_MS;
		if (staleByAge || ownedByDeadLocalProcess) {
			const stale = `${lockPath}.stale-${token}`;
			try {
				renameSync(lockPath, stale);
				rmSync(stale, { force: true });
				continue;
			} catch (cause) {
				rmSync(stale, { force: true });
				if (cause?.code === "ENOENT") continue;
				throw cause;
			}
		}
		const ownerDescription =
			current === null
				? "another process"
				: `${current.hostname ?? "unknown-host"}:${current.pid ?? "unknown-pid"}`;
		throw new Error(
			`Ghostty bootstrap is already running (${ownerDescription}): ${lockPath}`,
		);
	}
	throw new Error(`Could not acquire Ghostty bootstrap lock: ${lockPath}`);
};

/**
 * Owns the network/cache trust boundary shared by every Ghostty artifact build.
 * Creating the bootstrap is pure; `prepare()` verifies the pinned toolchain and
 * source checkout only when the caller actually needs to rebuild an artifact.
 * Its returned release function keeps shared source/cache mutation exclusive
 * through the caller's build and must be invoked from that build's `finally`.
 */
export function createGhosttyBuildBootstrap({
	cacheRoot,
	revision,
	zigVersion,
	tempLabel,
	zigRootName = `zig-${zigVersion}`,
	externalZig,
}) {
	const hostPlatform =
		process.platform === "darwin"
			? "macos"
			: process.platform === "linux"
				? "linux"
				: null;
	if (hostPlatform === null) {
		throw new Error(`Unsupported Ghostty build platform: ${process.platform}`);
	}
	const hostArchitecture = new Map([
		["arm64", "aarch64"],
		["x64", "x86_64"],
	]).get(process.arch);
	if (hostArchitecture === undefined) {
		throw new Error(`Unsupported Ghostty build architecture: ${process.arch}`);
	}
	const zigDistribution = `zig-${hostArchitecture}-${hostPlatform}-${zigVersion}.tar.xz`;
	const zigArchiveSha256 = ZIG_DISTRIBUTION_SHA256.get(
		`${hostArchitecture}-${hostPlatform}`,
	);
	if (zigArchiveSha256 === undefined) {
		throw new Error(`Missing checksum for Zig distribution ${zigDistribution}`);
	}
	const sourceRoot = path.join(cacheRoot, `source-${revision.slice(0, 12)}`);
	const zigRoot = path.join(cacheRoot, zigRootName);
	const cachedZigExecutable = path.join(zigRoot, "zig");
	// Always execute Zig from the distribution reconstructed from the pinned,
	// checksum-verified archive. A matching external executable does not prove
	// that its adjacent standard library is genuine.
	const zigExecutable = cachedZigExecutable;
	const zigArchive = path.join(cacheRoot, zigDistribution);
	const lockPath = path.join(cacheRoot, "ZUSE-BOOTSTRAP.lock");

	const ensureZig = () => {
		mkdirSync(cacheRoot, { recursive: true });
		if (!existsSync(zigArchive)) {
			const partial = `${zigArchive}.partial-${process.pid}`;
			try {
				run("curl", [
					"-fsSL",
					`https://ziglang.org/download/${zigVersion}/${zigDistribution}`,
					"-o",
					partial,
				]);
				if (sha256(partial) !== zigArchiveSha256) {
					throw new Error(`Zig ${zigVersion} archive checksum mismatch`);
				}
				renameSync(partial, zigArchive);
			} catch (cause) {
				rmSync(partial, { force: true });
				throw cause;
			}
		}
		if (sha256(zigArchive) !== zigArchiveSha256) {
			throw new Error(`Cached Zig archive checksum mismatch: ${zigArchive}`);
		}

		const extraction = mkdtempSync(
			path.join(cacheRoot, `.zig-verified-${tempLabel}-`),
		);
		let extractionOwnsDistribution = true;
		try {
			run("tar", [
				"-xJf",
				zigArchive,
				"--strip-components=1",
				"-C",
				extraction,
			]);
			const verifiedVersion = outputOf(path.join(extraction, "zig"), [
				"version",
			]);
			if (verifiedVersion !== zigVersion) {
				throw new Error(
					`Expected verified Zig ${zigVersion}, found ${verifiedVersion}`,
				);
			}

			let cacheMatchesVerifiedDistribution = false;
			if (existsSync(zigRoot)) {
				try {
					assertMatchingZigDistribution({
						cachedRoot: zigRoot,
						verifiedRoot: extraction,
					});
					cacheMatchesVerifiedDistribution = true;
				} catch {
					cacheMatchesVerifiedDistribution = false;
				}
			}
			if (!cacheMatchesVerifiedDistribution) {
				const displaced = `${zigRoot}.replaced-${process.pid}`;
				rmSync(displaced, { recursive: true, force: true });
				if (existsSync(zigRoot)) renameSync(zigRoot, displaced);
				try {
					renameSync(extraction, zigRoot);
					extractionOwnsDistribution = false;
				} catch (cause) {
					if (existsSync(displaced) && !existsSync(zigRoot)) {
						renameSync(displaced, zigRoot);
					}
					throw cause;
				}
				rmSync(displaced, { recursive: true, force: true });
			}
			const verifiedRoot = cacheMatchesVerifiedDistribution
				? extraction
				: zigRoot;
			const distributionSha256 = zigDistributionDigest(verifiedRoot);
			const binarySha256 = sha256(cachedZigExecutable);
			writeFileSync(
				path.join(zigRoot, ZIG_INTEGRITY_RECORD),
				`${JSON.stringify(
					{
						archiveSha256: zigArchiveSha256,
						binarySha256,
						distributionSha256,
						version: zigVersion,
					},
					null,
					"\t",
				)}\n`,
			);
		} finally {
			if (extractionOwnsDistribution) {
				rmSync(extraction, { recursive: true, force: true });
			}
		}

		const actual = outputOf(cachedZigExecutable, ["version"]);
		if (actual !== zigVersion) {
			throw new Error(`Expected Zig ${zigVersion}, found ${actual}`);
		}

		if (externalZig !== undefined) {
			assertMatchingExternalZig({
				cachedZig: cachedZigExecutable,
				externalZig,
				zigDistribution,
				zigVersion,
			});
		}
	};

	const ensureSource = () => {
		if (!existsSync(path.join(sourceRoot, ".git"))) {
			mkdirSync(sourceRoot, { recursive: true });
			run("git", ["init", sourceRoot]);
			run("git", [
				"-C",
				sourceRoot,
				"remote",
				"add",
				"origin",
				GHOSTTY_REPOSITORY,
			]);
		}
		const remote = outputOf("git", [
			"-C",
			sourceRoot,
			"remote",
			"get-url",
			"origin",
		]);
		if (remote !== GHOSTTY_REPOSITORY) {
			throw new Error(`Unexpected Ghostty origin: ${remote}`);
		}
		assertCleanSource(sourceRoot);
		run("git", ["-C", sourceRoot, "fetch", "--depth=1", "origin", revision]);
		const fetched = outputOf("git", [
			"-C",
			sourceRoot,
			"rev-parse",
			"FETCH_HEAD",
		]);
		if (fetched !== revision) {
			throw new Error(`Expected fetched Ghostty ${revision}, found ${fetched}`);
		}
		run("git", ["-C", sourceRoot, "checkout", "--detach", fetched]);
		const actual = outputOf("git", ["-C", sourceRoot, "rev-parse", "HEAD"]);
		if (actual !== revision) {
			throw new Error(`Expected Ghostty ${revision}, found ${actual}`);
		}
		assertCleanSource(sourceRoot);
	};

	return Object.freeze({
		cacheRoot,
		cachedZigExecutable,
		hostArchitecture,
		hostPlatform,
		lockPath,
		prepare() {
			const release = acquireBootstrapLock(cacheRoot);
			try {
				ensureZig();
				ensureSource();
				return release;
			} catch (cause) {
				release();
				throw cause;
			}
		},
		sourceRoot,
		zigArchive,
		zigArchiveSha256,
		zigDistribution,
		zigExecutable,
		zigRoot,
	});
}
