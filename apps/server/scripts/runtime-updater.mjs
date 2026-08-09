#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import {
	mkdir,
	readFile,
	readlink,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const releasesRoot = process.env.ZUSE_RELEASES_ROOT ?? "/opt/zuse/releases";
const currentLink = process.env.ZUSE_CURRENT_LINK ?? "/opt/zuse/current";
const manifestUrl = process.env.ZUSE_RUNTIME_MANIFEST_URL;
const publicKeyFile =
	process.env.ZUSE_RUNTIME_PUBLIC_KEY_FILE ??
	"/etc/zuse/runtime-signing-public.jwk";
const healthUrl =
	process.env.ZUSE_RUNTIME_HEALTH_URL ?? "http://127.0.0.1:47837/healthz";
const requestFile = process.env.ZUSE_RUNTIME_UPDATE_REQUEST_FILE;
const statusFile =
	process.env.ZUSE_RUNTIME_UPDATE_STATUS_FILE ??
	"/var/lib/zuse/runtime-update/status.json";
const installOnly = process.env.ZUSE_RUNTIME_INSTALL_ONLY === "1";
const skipToolchain = process.env.ZUSE_RUNTIME_SKIP_TOOLCHAIN === "1";
const checkOnly = process.argv.includes("--check");
const expectedWireProtocol = Number(process.env.ZUSE_RUNTIME_WIRE_PROTOCOL);

if (manifestUrl === undefined) {
	throw new Error("ZUSE_RUNTIME_MANIFEST_URL is required");
}
if (!Number.isInteger(expectedWireProtocol) || expectedWireProtocol < 1) {
	throw new Error("ZUSE_RUNTIME_WIRE_PROTOCOL must be a positive integer");
}

const readJson = async (path, maxBytes = 16 * 1_024) => {
	try {
		if ((await stat(path)).size > maxBytes) return null;
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return null;
	}
};

const installedMetadata = async () => {
	const metadata = await readJson(join(currentLink, "runtime-metadata.json"));
	if (
		metadata?.schemaVersion !== 1 ||
		typeof metadata.appVersion !== "string" ||
		typeof metadata.runtimeVersion !== "string"
	) {
		return {};
	}
	return {
		installedAppVersion: metadata.appVersion,
		installedRuntimeVersion: metadata.runtimeVersion,
	};
};

const writeStatus = async (status) => {
	const next = {
		...status,
		progressPercent: Math.max(0, Math.min(100, status.progressPercent)),
		updatedAt: Date.now(),
	};
	await mkdir(dirname(statusFile), { recursive: true, mode: 0o755 });
	const temporary = `${statusFile}.next-${randomUUID()}`;
	await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o644 });
	await rename(temporary, statusFile);
	return next;
};

const requestedTargetAppVersion = async () => {
	const environmentTarget =
		process.env.ZUSE_RUNTIME_DESIRED_APP_VERSION?.trim();
	const request =
		requestFile === undefined ? null : await readJson(requestFile, 1_024);
	const candidate =
		environmentTarget ||
		(typeof request?.targetAppVersion === "string"
			? request.targetAppVersion.trim()
			: undefined);
	return candidate !== undefined &&
		/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u.test(candidate)
		? candidate
		: undefined;
};

const publicJwk = JSON.parse(await readFile(publicKeyFile, "utf8"));
const signingKey = createPublicKey({ key: publicJwk, format: "jwk" });
const retryDelaysMs = [0, 500, 1_000, 2_000, 4_000];
const fetchWithRetry = async (url, label, decode) => {
	let lastCause;
	for (const delayMs of retryDelaysMs) {
		if (delayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
		try {
			const response = await fetch(url, {
				signal: AbortSignal.timeout(15_000),
			});
			if (!response.ok) {
				throw new Error(`${label} request failed: ${response.status}`);
			}
			return await decode(response);
		} catch (cause) {
			lastCause = cause;
		}
	}
	throw new Error(`${label} failed after ${retryDelaysMs.length} attempts`, {
		cause: lastCause,
	});
};

const fetchManifest = () =>
	fetchWithRetry(manifestUrl, "Manifest", async (response) => {
		const signed = await response.json();
		const { signature, ...candidate } = signed;
		if (typeof signature !== "string") throw new Error("Manifest is unsigned");
		const valid = verify(
			null,
			Buffer.from(JSON.stringify(candidate)),
			signingKey,
			Buffer.from(signature, "base64url"),
		);
		if (!valid) throw new Error("Manifest signature is invalid");
		if (
			candidate.architecture !== "linux-x64" ||
			typeof candidate.version !== "string" ||
			typeof candidate.appVersion !== "string" ||
			!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u.test(candidate.version) ||
			!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u.test(candidate.appVersion)
		) {
			throw new Error("Runtime manifest metadata is invalid");
		}
		const wireProtocol = candidate.wireProtocol;
		if (
			typeof wireProtocol !== "object" ||
			wireProtocol === null ||
			!Number.isInteger(wireProtocol.min) ||
			!Number.isInteger(wireProtocol.max) ||
			wireProtocol.min < 1 ||
			wireProtocol.max < wireProtocol.min
		) {
			throw new Error("Runtime wire protocol metadata is invalid");
		}
		if (
			wireProtocol.min > expectedWireProtocol ||
			wireProtocol.max < expectedWireProtocol
		) {
			throw new Error("Runtime wire protocol is incompatible");
		}
		if (
			typeof candidate.toolchain !== "object" ||
			candidate.toolchain === null ||
			typeof candidate.toolchain.version !== "string" ||
			!/^\d{4}\.\d{2}\.\d{2}\.\d+$/u.test(candidate.toolchain.version) ||
			typeof candidate.toolchain.sha256 !== "string" ||
			!/^[a-f0-9]{64}$/u.test(candidate.toolchain.sha256)
		) {
			throw new Error("Runtime toolchain metadata is invalid");
		}
		if (new URL(candidate.url).protocol !== "https:") {
			throw new Error("Runtime URL must use HTTPS");
		}
		return candidate;
	});

const targetAppVersion = await requestedTargetAppVersion();

if (checkOnly) {
	const durable = await readJson(statusFile);
	const updatingPhases = new Set([
		"queued",
		"downloading",
		"installing",
		"developer-tools",
		"restarting",
		"verifying",
		"rolling-back",
	]);
	if (
		targetAppVersion !== undefined &&
		durable !== null &&
		durable.targetAppVersion === targetAppVersion &&
		updatingPhases.has(durable.phase) &&
		typeof durable.updatedAt === "number" &&
		Date.now() - durable.updatedAt < 60 * 60 * 1_000
	) {
		console.log(JSON.stringify(durable));
		process.exit(0);
	}
	try {
		const [manifest, installed] = await Promise.all([
			fetchManifest(),
			installedMetadata(),
		]);
		const desired = targetAppVersion ?? manifest.appVersion;
		const available = manifest.appVersion === desired;
		const current =
			available && installed.installedRuntimeVersion === manifest.version;
		console.log(
			JSON.stringify({
				state: available
					? current
						? "current"
						: "update-available"
					: "unavailable",
				phase: current ? "complete" : "idle",
				progressPercent: current ? 100 : 0,
				targetAppVersion: desired,
				...installed,
				targetRuntimeVersion: manifest.version,
				...(available ? {} : { failureCode: "target-version-unavailable" }),
				updatedAt: Date.now(),
			}),
		);
	} catch {
		console.log(
			JSON.stringify({
				state: "unavailable",
				phase: "failed",
				progressPercent: 0,
				targetAppVersion: targetAppVersion ?? "unknown",
				failureCode: "check-failed",
				updatedAt: Date.now(),
			}),
		);
	}
	process.exit(0);
}

let lastStatus = {
	state: "updating",
	phase: "checking",
	progressPercent: 5,
	targetAppVersion: targetAppVersion ?? "unknown",
};
let failureCode = "install-failed";

try {
	lastStatus = await writeStatus(lastStatus);
	const manifest = await fetchManifest();
	const desired = targetAppVersion ?? manifest.appVersion;
	lastStatus = {
		...lastStatus,
		targetAppVersion: desired,
		targetRuntimeVersion: manifest.version,
	};
	if (manifest.appVersion !== desired) {
		failureCode = "target-version-unavailable";
		throw new Error("Requested app version is not available");
	}
	const installed = await installedMetadata();
	if (installed.installedRuntimeVersion === manifest.version) {
		lastStatus = await writeStatus({
			state: "current",
			phase: "complete",
			progressPercent: 100,
			targetAppVersion: desired,
			...installed,
			targetRuntimeVersion: manifest.version,
		});
		if (requestFile !== undefined) {
			await rm(requestFile, { force: true });
		}
		process.exit(0);
	}

	lastStatus = await writeStatus({
		...lastStatus,
		phase: "downloading",
		progressPercent: 20,
		...installed,
	});
	const archive = await fetchWithRetry(
		manifest.url,
		"Runtime",
		async (response) => {
			const candidate = Buffer.from(await response.arrayBuffer());
			const digest = createHash("sha256").update(candidate).digest("hex");
			if (digest !== manifest.sha256)
				throw new Error("Runtime hash is invalid");
			return candidate;
		},
	);

	lastStatus = await writeStatus({
		...lastStatus,
		phase: "installing",
		progressPercent: 50,
		...installed,
	});
	const staging = join(
		releasesRoot,
		`${manifest.version}.staging-${randomUUID()}`,
	);
	const release = join(
		releasesRoot,
		`${manifest.version}-${manifest.sha256.slice(0, 12)}`,
	);
	await mkdir(staging, { recursive: true, mode: 0o755 });
	const archivePath = join(staging, "runtime.tar.gz");
	await writeFile(archivePath, archive, { mode: 0o600 });

	const run = (command, args) =>
		new Promise((resolve, reject) => {
			const child = spawn(command, args, { stdio: "inherit" });
			child.once("error", reject);
			child.once("exit", (code) =>
				code === 0
					? resolve()
					: reject(new Error(`${command} exited with ${code}`)),
			);
		});

	const waitForHealthyRuntime = async () => {
		for (let attempt = 0; attempt < 15; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			try {
				const response = await fetch(healthUrl, {
					signal: AbortSignal.timeout(2_000),
				});
				const body = await response.json();
				if (
					response.ok &&
					body.status === "ok" &&
					body.wireProtocolVersion === expectedWireProtocol
				) {
					return true;
				}
			} catch {
				// Retry until the fixed health-check budget expires.
			}
		}
		return false;
	};

	await run("tar", ["-xzf", archivePath, "-C", staging]);
	await rm(archivePath);
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

	const toolchainManifestPath = join(release, "toolchain-manifest.json");
	const toolchainManifestBytes = await readFile(toolchainManifestPath);
	const toolchainManifestDigest = createHash("sha256")
		.update(toolchainManifestBytes)
		.digest("hex");
	const toolchainManifest = JSON.parse(toolchainManifestBytes);
	if (
		toolchainManifestDigest !== manifest.toolchain.sha256 ||
		toolchainManifest.version !== manifest.toolchain.version
	) {
		throw new Error("Signed toolchain manifest does not match the runtime");
	}

	let previousTarget;
	try {
		previousTarget = await readlink(currentLink);
	} catch {
		previousTarget = undefined;
	}
	let previousToolchainTarget;
	try {
		previousToolchainTarget = await readlink("/opt/zuse/toolchain-current");
	} catch {
		previousToolchainTarget = undefined;
	}
	if (!skipToolchain) {
		lastStatus = await writeStatus({
			...lastStatus,
			phase: "developer-tools",
			progressPercent: 70,
			...installed,
		});
		await run("/usr/local/bin/node", [
			join(release, "toolchain-reconciler.mjs"),
			toolchainManifestPath,
		]);
	}
	const temporaryLink = `${currentLink}.next-${randomUUID()}`;
	await symlink(release, temporaryLink);
	await rename(temporaryLink, currentLink);

	if (installOnly) {
		lastStatus = await writeStatus({
			state: "current",
			phase: "complete",
			progressPercent: 100,
			targetAppVersion: desired,
			installedAppVersion: manifest.appVersion,
			installedRuntimeVersion: manifest.version,
			targetRuntimeVersion: manifest.version,
		});
		console.log(`Installed Zuse cloud runtime ${manifest.version}`);
	} else {
		lastStatus = await writeStatus({
			...lastStatus,
			phase: "restarting",
			progressPercent: 85,
			...installed,
		});
		await run("systemctl", ["restart", "zuse.service"]);
		lastStatus = await writeStatus({
			...lastStatus,
			phase: "verifying",
			progressPercent: 92,
			...installed,
		});
		if (!(await waitForHealthyRuntime())) {
			failureCode = "rollback-complete";
			lastStatus = await writeStatus({
				...lastStatus,
				phase: "rolling-back",
				progressPercent: 95,
				...installed,
			});
			if (!skipToolchain) {
				if (previousToolchainTarget === undefined) {
					await rm("/opt/zuse/toolchain-current", { force: true });
				} else {
					const toolchainRollback = `/opt/zuse/toolchain-current.rollback-${randomUUID()}`;
					await symlink(previousToolchainTarget, toolchainRollback);
					await rename(toolchainRollback, "/opt/zuse/toolchain-current");
				}
			}
			if (previousTarget === undefined) {
				failureCode = "health-check-failed";
				await rm(currentLink, { force: true });
				throw new Error(
					"Runtime health check failed; no prior release to restore",
				);
			}
			const rollbackLink = `${currentLink}.rollback-${randomUUID()}`;
			await symlink(previousTarget, rollbackLink);
			await rename(rollbackLink, currentLink);
			await run("systemctl", ["restart", "zuse.service"]);
			if (!(await waitForHealthyRuntime())) {
				failureCode = "health-check-failed";
				throw new Error("Rollback runtime failed its health check");
			}
			throw new Error("Runtime health check failed; rolled back");
		}
		await writeStatus({
			state: "current",
			phase: "complete",
			progressPercent: 100,
			targetAppVersion: desired,
			installedAppVersion: manifest.appVersion,
			installedRuntimeVersion: manifest.version,
			targetRuntimeVersion: manifest.version,
		});
	}
} catch {
	await writeStatus({
		...lastStatus,
		state: "failed",
		phase: "failed",
		failureCode,
	});
	process.exitCode = 1;
} finally {
	if (requestFile !== undefined) {
		await rm(requestFile, { force: true });
	}
}
