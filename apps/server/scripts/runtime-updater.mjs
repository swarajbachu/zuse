#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import {
	mkdir,
	open,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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
const journalFile =
	process.env.ZUSE_RUNTIME_UPDATE_JOURNAL_FILE ??
	join(dirname(statusFile), "transaction.json");
const transactionId = process.env.ZUSE_RUNTIME_UPDATE_TRANSACTION_ID;
const generation = Number(process.env.ZUSE_RUNTIME_UPDATE_GENERATION);
const expectedVersion = process.env.ZUSE_RUNTIME_EXPECTED_VERSION;
const action = ["prepare", "activate", "confirm", "rollback", "status"].find(
	(name) => process.argv.includes(`--${name}`),
);
const installOnly = process.env.ZUSE_RUNTIME_INSTALL_ONLY === "1";
const skipToolchain = process.env.ZUSE_RUNTIME_SKIP_TOOLCHAIN === "1";
const checkOnly = process.argv.includes("--check");
const expectedWireProtocol = Number(process.env.ZUSE_RUNTIME_WIRE_PROTOCOL);

if (
	manifestUrl === undefined &&
	(action === undefined || action === "prepare")
) {
	throw new Error("ZUSE_RUNTIME_MANIFEST_URL is required");
}
if (
	action !== "status" &&
	(!Number.isInteger(expectedWireProtocol) || expectedWireProtocol < 1)
) {
	throw new Error("ZUSE_RUNTIME_WIRE_PROTOCOL must be a positive integer");
}

if (
	action !== undefined &&
	action !== "status" &&
	(typeof transactionId !== "string" ||
		transactionId.length === 0 ||
		transactionId.length > 128)
) {
	throw new Error("ZUSE_RUNTIME_UPDATE_TRANSACTION_ID is required");
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
	await durableJson(statusFile, next);
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

const signingKey = async () =>
	createPublicKey({
		key: JSON.parse(await readFile(publicKeyFile, "utf8")),
		format: "jwk",
	});
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
	throw new Error(
		`${label} failed after ${retryDelaysMs.length} attempts: ${lastCause instanceof Error ? lastCause.message : "unknown failure"}`,
		{
			cause: lastCause,
		},
	);
};

const validateManifest = async (signed) => {
	const { signature, ...candidate } = signed;
	if (typeof signature !== "string") throw new Error("Manifest is unsigned");
	const valid = verify(
		null,
		Buffer.from(JSON.stringify(candidate)),
		await signingKey(),
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
	if (
		typeof candidate.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/u.test(candidate.sha256)
	) {
		throw new Error("Runtime checksum metadata is invalid");
	}
	return { ...candidate, signature };
};
const fetchManifest = () =>
	fetchWithRetry(manifestUrl, "Manifest", async (response) =>
		validateManifest(await response.json()),
	);

const targetAppVersion = await requestedTargetAppVersion();

// Persist intents before changing a release pointer. fsync the directory as well
// as the file so a reboot cannot lose the rename that protects the prior release.
const durableJson = async (path, value) => {
	await mkdir(dirname(path), { recursive: true, mode: 0o755 });
	const temporary = `${path}.next-${randomUUID()}`;
	const file = await open(temporary, "wx", 0o644);
	try {
		await file.writeFile(`${JSON.stringify(value)}\n`);
		await file.sync();
	} finally {
		await file.close();
	}
	await rename(temporary, path);
	const directory = await open(dirname(path), "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
};
const readJournal = async () => {
	let journal;
	try {
		journal = JSON.parse(await readFile(journalFile, "utf8"));
	} catch (cause) {
		if (cause.code === "ENOENT") return null;
		throw new Error("Cannot read runtime update journal", { cause });
	}
	if (
		journal?.schemaVersion !== 1 ||
		typeof journal.transactionId !== "string" ||
		![
			"prepared",
			"activating",
			"activated",
			"rolling-back",
			"rolled-back",
			"confirmed",
		].includes(journal.phase) ||
		typeof journal.candidate?.release !== "string" ||
		typeof journal.candidate?.version !== "string"
	)
		throw new Error("Unsupported update journal");
	return journal;
};
if (action === "status") {
	console.log(JSON.stringify(await readJournal()));
	process.exit(0);
}

if (checkOnly) {
	const transaction = await readJournal();
	if (transaction !== null && transaction.phase !== "confirmed") {
		console.log(
			JSON.stringify({
				state: "updating",
				phase: "verifying",
				progressPercent: 90,
				targetAppVersion: transaction.candidate.appVersion,
				targetRuntimeVersion: transaction.candidate.version,
				transactionId: transaction.transactionId,
				transactionPhase: transaction.phase,
				updatedAt: transaction.updatedAt,
				...(await installedMetadata()),
			}),
		);
		process.exit(0);
	}
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

// flock is held by the updater process itself and is released even on SIGKILL.
// A killed download cannot leave a stale lock that blocks recovery forever.
if (process.env.ZUSE_RUNTIME_UPDATER_LOCKED !== "1") {
	await mkdir(dirname(journalFile), { recursive: true, mode: 0o755 });
	const child = spawn(
		"flock",
		[
			"--exclusive",
			"--nonblock",
			"--no-fork",
			`${journalFile}.lock`,
			process.execPath,
			...process.execArgv,
			...process.argv.slice(1),
		],
		{
			stdio: "inherit",
			env: { ...process.env, ZUSE_RUNTIME_UPDATER_LOCKED: "1" },
		},
	);
	child.once("error", (cause) => {
		console.error(cause.message);
		process.exitCode = 1;
	});
	child.once("exit", (code) => {
		process.exitCode = code ?? 1;
	});
} else {
	await update();
}

async function update() {
	let lastStatus = {
		state: "updating",
		phase: "checking",
		progressPercent: 5,
		targetAppVersion: targetAppVersion ?? "unknown",
	};
	let failureCode = "install-failed";
	let journal = await readJournal();
	const save = async (changes) => {
		journal = { ...journal, ...changes, updatedAt: Date.now() };
		await durableJson(journalFile, journal);
		return journal;
	};
	const assertTransaction = () => {
		if (journal === null) throw new Error("No prepared runtime transaction");
		if (transactionId !== undefined && transactionId !== journal.transactionId)
			throw new Error("Runtime transaction does not match");
	};
	const requireGeneration = () => {
		if (!Number.isSafeInteger(generation) || generation < 1)
			throw new Error(
				"ZUSE_RUNTIME_UPDATE_GENERATION must be a positive integer",
			);
	};
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
	const currentTarget = async () => {
		try {
			return await realpath(currentLink);
		} catch (cause) {
			if (cause.code === "ENOENT") return null;
			throw cause;
		}
	};
	const swap = async (release) => {
		const temporary = `${currentLink}.next-${randomUUID()}`;
		await symlink(release, temporary);
		await rename(temporary, currentLink);
		const directory = await open(dirname(currentLink), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	};
	const verifiedRelease = async (release) => {
		const manifest = await validateManifest(
			await readJson(join(release, "runtime-signed-manifest.json")),
		);
		const archive = await readFile(
			join(release, "runtime-signed-archive.tar.gz"),
		);
		if (createHash("sha256").update(archive).digest("hex") !== manifest.sha256)
			throw new Error("Retained runtime hash is invalid");
		const metadata = await readJson(join(release, "runtime-metadata.json"));
		if (
			metadata?.runtimeVersion !== manifest.version ||
			metadata?.appVersion !== manifest.appVersion
		)
			throw new Error("Runtime metadata does not match signed release");
		return {
			release,
			version: manifest.version,
			appVersion: manifest.appVersion,
			wireProtocol: manifest.wireProtocol,
		};
	};
	const inspectPrevious = async () => {
		const release = await currentTarget();
		if (release === null) return null;
		const metadata = await readJson(join(release, "runtime-metadata.json"));
		try {
			return { ...(await verifiedRelease(release)), signed: true };
		} catch {
			// Old images did not retain a signature. Preserve them but never claim
			// that an unverified binary is a compatible signed rollback target.
			return {
				release,
				version: metadata?.runtimeVersion ?? null,
				appVersion: metadata?.appVersion ?? null,
				signed: false,
			};
		}
	};
	const publishStatus = async () => {
		const confirmed = journal.phase === "confirmed";
		lastStatus = await writeStatus({
			state: confirmed ? "current" : "updating",
			phase: confirmed
				? "complete"
				: journal.phase === "prepared"
					? "installing"
					: "verifying",
			progressPercent: confirmed ? 100 : journal.phase === "prepared" ? 75 : 90,
			targetAppVersion: journal.candidate.appVersion,
			targetRuntimeVersion: journal.candidate.version,
			transactionId: journal.transactionId,
			transactionPhase: journal.phase,
			...(await installedMetadata()),
		});
	};
	const prepare = async () => {
		// Image installers activate bytes without owning a workspace generation.
		// Adopt that installed baseline into the first control-plane transaction;
		// it remains unconfirmed and its signed release becomes the rollback target.
		// A prepared API operation or any fenced activation cannot be superseded.
		const legacyBaseline =
			journal?.phase === "activated" &&
			journal.generation === null &&
			transactionId !== undefined &&
			transactionId !== journal.transactionId &&
			(await currentTarget()) === journal.candidate.release;
		if (
			journal !== null &&
			!legacyBaseline &&
			(journal.phase !== "confirmed" || transactionId === journal.transactionId)
		) {
			if (
				transactionId !== undefined &&
				transactionId !== journal.transactionId
			)
				throw new Error(
					"Another runtime transaction requires confirmation or rollback",
				);
			if (
				targetAppVersion !== undefined &&
				targetAppVersion !== journal.candidate.appVersion
			)
				throw new Error(
					"Pending runtime transaction targets another app version",
				);
			await verifiedRelease(journal.candidate.release);
			return;
		}
		const manifest = await fetchManifest();
		const desired = targetAppVersion ?? manifest.appVersion;
		if (manifest.appVersion !== desired) {
			failureCode = "target-version-unavailable";
			throw new Error("Requested app version is not available");
		}
		lastStatus = await writeStatus({
			...lastStatus,
			targetAppVersion: desired,
			targetRuntimeVersion: manifest.version,
			phase: "downloading",
			progressPercent: 20,
		});
		const archive = await fetchWithRetry(
			manifest.url,
			"Runtime",
			async (response) => {
				const bytes = Buffer.from(await response.arrayBuffer());
				if (
					createHash("sha256").update(bytes).digest("hex") !== manifest.sha256
				)
					throw new Error("Runtime hash is invalid");
				return bytes;
			},
		);
		const staging = join(
			releasesRoot,
			`${manifest.version}.staging-${randomUUID()}`,
		);
		const release = resolve(
			releasesRoot,
			`${manifest.version}-${manifest.sha256.slice(0, 12)}-signed`,
		);
		await mkdir(staging, { recursive: true, mode: 0o755 });
		try {
			const archivePath = join(staging, "runtime.tar.gz");
			await writeFile(archivePath, archive, { mode: 0o600 });
			await run("tar", ["-xzf", archivePath, "-C", staging]);
			await rm(archivePath);
			const toolchainManifestBytes = await readFile(
				join(staging, "toolchain-manifest.json"),
			);
			const toolchainManifest = JSON.parse(toolchainManifestBytes);
			if (
				createHash("sha256").update(toolchainManifestBytes).digest("hex") !==
					manifest.toolchain.sha256 ||
				toolchainManifest.version !== manifest.toolchain.version
			)
				throw new Error("Signed toolchain manifest does not match the runtime");
			await durableJson(
				join(staging, "runtime-signed-manifest.json"),
				manifest,
			);
			const retainedArchive = await open(
				join(staging, "runtime-signed-archive.tar.gz"),
				"w",
				0o600,
			);
			try {
				await retainedArchive.writeFile(archive);
				await retainedArchive.sync();
			} finally {
				await retainedArchive.close();
			}
			await verifiedRelease(staging);
			const syncTree = async (directory) => {
				for (const entry of await readdir(directory, { withFileTypes: true })) {
					const path = join(directory, entry.name);
					if (entry.isDirectory()) await syncTree(path);
					else if (entry.isFile()) {
						const file = await open(path, "r");
						try {
							await file.sync();
						} finally {
							await file.close();
						}
					}
				}
				const handle = await open(directory, "r");
				try {
					await handle.sync();
				} finally {
					await handle.close();
				}
			};
			await syncTree(staging);
			try {
				await rename(staging, release);
			} catch (cause) {
				if (cause.code !== "EEXIST" && cause.code !== "ENOTEMPTY") throw cause;
				await verifiedRelease(release);
			}
			const releasesDirectory = await open(releasesRoot, "r");
			try {
				await releasesDirectory.sync();
			} finally {
				await releasesDirectory.close();
			}
			await save({
				schemaVersion: 1,
				transactionId: transactionId ?? randomUUID(),
				phase: "prepared",
				candidate: await verifiedRelease(release),
				previous: await inspectPrevious(),
				generation: null,
				previousToolchainTarget: await readlink(
					"/opt/zuse/toolchain-current",
				).catch(() => null),
				createdAt: Date.now(),
				confirmedVersion: null,
				confirmedAt: null,
			});
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	};
	const activate = async (legacy = false) => {
		assertTransaction();
		if (!legacy) requireGeneration();
		const nextGeneration =
			legacy && !Number.isSafeInteger(generation) ? null : generation;
		if (["activated", "confirmed"].includes(journal.phase)) {
			if (
				(await currentTarget()) !== journal.candidate.release ||
				(journal.generation !== nextGeneration &&
					(journal.phase === "confirmed" ||
						nextGeneration === null ||
						nextGeneration <= (journal.generation ?? 0)))
			)
				throw new Error(
					"Activation generation or current release does not match",
				);
			if (journal.generation !== nextGeneration)
				await save({ generation: nextGeneration });
			return;
		}
		if (!["prepared", "activating"].includes(journal.phase))
			throw new Error("Runtime transaction cannot activate in this phase");
		if (
			journal.phase === "activating" &&
			journal.generation !== nextGeneration &&
			(nextGeneration === null || nextGeneration <= (journal.generation ?? 0))
		)
			throw new Error("Interrupted activation belongs to a newer generation");
		const current = await currentTarget();
		if (
			current !== journal.previous?.release &&
			current !== journal.candidate.release &&
			!(current === null && journal.previous === null)
		)
			throw new Error("Current runtime changed after preparation");
		await verifiedRelease(journal.candidate.release);
		await save({ phase: "activating", generation: nextGeneration });
		if (!skipToolchain) {
			const release = journal.candidate.release;
			await run(process.execPath, [
				join(release, "toolchain-reconciler.mjs"),
				join(release, "toolchain-manifest.json"),
			]);
		}
		await swap(journal.candidate.release);
		await save({ phase: "activated" });
	};
	const rollback = async () => {
		assertTransaction();
		requireGeneration();
		if (
			journal.phase === "rolled-back" ||
			(journal.phase === "confirmed" &&
				journal.confirmedVersion === journal.previous?.version)
		) {
			if (
				(await currentTarget()) !== journal.previous?.release ||
				(journal.generation !== generation &&
					(journal.phase === "confirmed" || generation < journal.generation))
			)
				throw new Error(
					"Rollback generation or current release does not match",
				);
			if (journal.generation !== generation) {
				await verifiedRelease(journal.previous.release);
				await save({ generation });
			}
			return;
		}
		if (!["activated", "activating", "rolling-back"].includes(journal.phase))
			throw new Error("Runtime transaction cannot roll back in this phase");
		if (
			journal.phase === "rolling-back"
				? generation < journal.generation
				: generation <= (journal.generation ?? 0)
		)
			throw new Error("Rollback requires a fresh fenced runtime generation");
		if (journal.previous?.signed !== true)
			throw new Error("Previous release has no retained signed manifest");
		await verifiedRelease(journal.previous.release);
		const current = await currentTarget();
		if (
			current !== journal.candidate.release &&
			current !== journal.previous.release
		)
			throw new Error("Current runtime changed before rollback");
		await save({ phase: "rolling-back", generation });
		if (!skipToolchain) {
			if (journal.previousToolchainTarget === null)
				await rm("/opt/zuse/toolchain-current", { force: true });
			else {
				const link = `/opt/zuse/toolchain-current.rollback-${randomUUID()}`;
				await symlink(journal.previousToolchainTarget, link);
				await rename(link, "/opt/zuse/toolchain-current");
			}
		}
		await swap(journal.previous.release);
		await save({ phase: "rolled-back" });
	};
	const confirm = async () => {
		assertTransaction();
		requireGeneration();
		if (!["activated", "rolled-back", "confirmed"].includes(journal.phase))
			throw new Error("Runtime transaction is not ready for confirmation");
		const target =
			journal.phase === "rolled-back" ||
			(journal.phase === "confirmed" &&
				journal.confirmedVersion === journal.previous?.version)
				? journal.previous
				: journal.candidate;
		if (
			journal.generation !== generation ||
			expectedVersion !== target.version ||
			(await currentTarget()) !== target.release
		)
			throw new Error(
				"Runtime confirmation version or generation does not match",
			);
		await verifiedRelease(target.release);
		// The authenticated control plane invokes this only after the matching
		// runtime has enrolled and reported readiness. Local /healthz is not proof.
		await save({
			phase: "confirmed",
			confirmedVersion: target.version,
			confirmedAt: Date.now(),
		});
	};
	try {
		if (action === "prepare") await prepare();
		else if (action === "activate") await activate();
		else if (action === "rollback") await rollback();
		else if (action === "confirm") await confirm();
		else {
			await prepare();
			await activate(true);
			if (!installOnly) {
				await run("systemctl", ["restart", "zuse.service"]);
				// Preserve legacy service restart behavior, without confusing local
				// liveness with authenticated enrollment or reusing a boot token.
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
							)
								return true;
						} catch {
							/* Keep the fixed local-liveness budget. */
						}
					}
					return false;
				};
				if (!(await waitForHealthyRuntime()))
					throw new Error(
						"Runtime health check failed; explicit rollback with fresh authorization required",
					);
			}
		}
		await publishStatus();
		console.log(JSON.stringify(journal));
	} catch (cause) {
		const diagnostic =
			cause instanceof Error ? cause.message : "Unknown runtime update failure";
		console.error(`Runtime update failed: ${diagnostic}`);
		await writeStatus({
			...lastStatus,
			state: "failed",
			phase: "failed",
			failureCode,
			diagnostic,
		});
		process.exitCode = 1;
	} finally {
		if (
			requestFile !== undefined &&
			(action === undefined || (action === "confirm" && process.exitCode !== 1))
		)
			await rm(requestFile, { force: true });
	}
}
