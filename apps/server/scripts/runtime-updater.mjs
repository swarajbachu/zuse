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

if (manifestUrl === undefined) {
	throw new Error("ZUSE_RUNTIME_MANIFEST_URL is required");
}

const manifestResponse = await fetch(manifestUrl);
if (!manifestResponse.ok) {
	throw new Error(`Manifest request failed: ${manifestResponse.status}`);
}
const signed = await manifestResponse.json();
const { signature, ...manifest } = signed;
if (typeof signature !== "string") throw new Error("Manifest is unsigned");
const publicJwk = JSON.parse(await readFile(publicKeyFile, "utf8"));
const valid = verify(
	null,
	Buffer.from(JSON.stringify(manifest)),
	createPublicKey({ key: publicJwk, format: "jwk" }),
	Buffer.from(signature, "base64url"),
);
if (!valid) throw new Error("Manifest signature is invalid");
if (manifest.architecture !== "linux-x64") {
	throw new Error(`Unsupported architecture: ${manifest.architecture}`);
}
if (manifest.wireProtocol?.min > 2 || manifest.wireProtocol?.max < 2) {
	throw new Error("Runtime wire protocol is incompatible");
}

const archiveResponse = await fetch(manifest.url);
if (!archiveResponse.ok) {
	throw new Error(`Runtime request failed: ${archiveResponse.status}`);
}
const archive = Buffer.from(await archiveResponse.arrayBuffer());
const digest = createHash("sha256").update(archive).digest("hex");
if (digest !== manifest.sha256) throw new Error("Runtime hash is invalid");

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
await run("systemctl", ["restart", "zuse.service"]);

let healthy = false;
for (let attempt = 0; attempt < 15; attempt += 1) {
	await new Promise((resolve) => setTimeout(resolve, 1_000));
	try {
		const response = await fetch(healthUrl);
		const body = await response.json();
		if (response.ok && body.status === "ok" && body.wireProtocolVersion === 2) {
			healthy = true;
			break;
		}
	} catch {
		// Retry until the fixed health-check budget expires.
	}
}

if (!healthy) {
	if (previousTarget !== undefined) {
		const rollbackLink = `${currentLink}.rollback-${randomUUID()}`;
		await symlink(previousTarget, rollbackLink);
		await rename(rollbackLink, currentLink);
		await run("systemctl", ["restart", "zuse.service"]);
	}
	throw new Error("Runtime health check failed; rolled back");
}
