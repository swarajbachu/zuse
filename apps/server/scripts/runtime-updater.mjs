#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import {
	mkdir,
	readFile,
	readlink,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const releasesRoot = process.env.ZUSE_RELEASES_ROOT ?? "/opt/zuse/releases";
const currentLink = process.env.ZUSE_CURRENT_LINK ?? "/opt/zuse/current";
const manifestUrl = process.env.ZUSE_RUNTIME_MANIFEST_URL;
const publicKeyFile =
	process.env.ZUSE_RUNTIME_PUBLIC_KEY_FILE ??
	"/etc/zuse/runtime-signing-public.jwk";
const healthUrl =
	process.env.ZUSE_RUNTIME_HEALTH_URL ?? "http://127.0.0.1:47837/healthz";
const installOnly = process.env.ZUSE_RUNTIME_INSTALL_ONLY === "1";
const expectedWireProtocol = Number(process.env.ZUSE_RUNTIME_WIRE_PROTOCOL);

if (manifestUrl === undefined) {
	throw new Error("ZUSE_RUNTIME_MANIFEST_URL is required");
}
if (!Number.isInteger(expectedWireProtocol) || expectedWireProtocol < 1) {
	throw new Error("ZUSE_RUNTIME_WIRE_PROTOCOL must be a positive integer");
}

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

const manifest = await fetchWithRetry(
	manifestUrl,
	"Manifest",
	async (response) => {
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
		if (candidate.architecture !== "linux-x64") {
			throw new Error(`Unsupported architecture: ${candidate.architecture}`);
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
		if (new URL(candidate.url).protocol !== "https:") {
			throw new Error("Runtime URL must use HTTPS");
		}
		return candidate;
	},
);

const archive = await fetchWithRetry(
	manifest.url,
	"Runtime",
	async (response) => {
		const candidate = Buffer.from(await response.arrayBuffer());
		const digest = createHash("sha256").update(candidate).digest("hex");
		if (digest !== manifest.sha256) throw new Error("Runtime hash is invalid");
		return candidate;
	},
);

const staging = join(
	releasesRoot,
	`${manifest.version}.staging-${randomUUID()}`,
);
// Content-addressed release directories are immutable. In particular, never
// remove a directory that the current symlink may still reference.
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

let previousTarget;
try {
	previousTarget = await readlink(currentLink);
} catch {
	previousTarget = undefined;
}
const temporaryLink = `${currentLink}.next-${randomUUID()}`;
await symlink(release, temporaryLink);
await rename(temporaryLink, currentLink);

if (installOnly) {
	console.log(`Installed Zuse cloud runtime ${manifest.version}`);
} else {
	await run("systemctl", ["restart", "zuse.service"]);
	if (!(await waitForHealthyRuntime())) {
		if (previousTarget === undefined) {
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
			throw new Error("Rollback runtime failed its health check");
		}
		throw new Error("Runtime health check failed; rolled back");
	}
}
