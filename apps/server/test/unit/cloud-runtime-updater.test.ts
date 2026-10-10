import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("cloud runtime updater status", () => {
	test.each([
		4, 6,
	])("checks the installed runtime against API protocol %i", async (protocol) => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-updater-status-"));
		temporaryDirectories.push(directory);
		const release = join(directory, "release");
		const current = join(directory, "current");
		const publicKeyFile = join(directory, "runtime-public.jwk");
		await mkdir(release, { recursive: true });
		await writeFile(
			join(release, "runtime-metadata.json"),
			JSON.stringify({
				schemaVersion: 1,
				appVersion: "0.16.0",
				runtimeVersion: "old-runtime",
				wireProtocolVersion: 4,
			}),
		);
		await symlink(release, current);

		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		await writeFile(
			publicKeyFile,
			JSON.stringify(publicKey.export({ format: "jwk" })),
		);
		const manifest = {
			channel: "stable",
			version: "new-runtime",
			appVersion: "0.17.1",
			url: "https://example.com/runtime.tar.gz",
			architecture: "linux-x64",
			sha256: "a".repeat(64),
			wireProtocol: { min: 4, max: 4 },
			toolchain: { version: "2026.08.07.1", sha256: "b".repeat(64) },
			sizeBytes: 1,
		};
		const signed = {
			...manifest,
			signature: sign(
				null,
				Buffer.from(JSON.stringify(manifest)),
				privateKey,
			).toString("base64url"),
		};
		const server = createServer((_request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify(signed));
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (address === null || typeof address === "string") {
			throw new Error("test server did not bind");
		}

		try {
			const operation = execFileAsync(
				process.execPath,
				[
					join(import.meta.dirname, "../../scripts/runtime-updater.mjs"),
					...(protocol === 4 ? ["--check"] : []),
				],
				{
					env: {
						...process.env,
						ZUSE_CURRENT_LINK: current,
						ZUSE_RUNTIME_INSTALL_ONLY: "1",
						ZUSE_RUNTIME_MANIFEST_URL: `http://127.0.0.1:${address.port}/manifest`,
						ZUSE_RUNTIME_PUBLIC_KEY_FILE: publicKeyFile,
						ZUSE_RUNTIME_WIRE_PROTOCOL: String(protocol),
						ZUSE_RUNTIME_UPDATE_STATUS_FILE: join(directory, "status.json"),
						ZUSE_RUNTIME_DESIRED_APP_VERSION: "0.17.1",
					},
				},
			);
			if (protocol === 6) {
				await expect(operation).rejects.toMatchObject({
					stderr: expect.stringContaining(
						"Runtime wire protocol is incompatible",
					),
				});
				return;
			}
			const result = await operation;
			const status = JSON.parse(result.stdout);
			expect(status).toMatchObject({
				state: "update-available",
				phase: "idle",
				targetAppVersion: "0.17.1",
				installedAppVersion: "0.16.0",
				installedRuntimeVersion: "old-runtime",
				targetRuntimeVersion: "new-runtime",
			});
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	}, 15_000);
});

const updater = join(import.meta.dirname, "../../scripts/runtime-updater.mjs");

const transactionFixture = async () => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-update-transaction-"));
	temporaryDirectories.push(directory);
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const publicKeyFile = join(directory, "public.jwk");
	await writeFile(
		publicKeyFile,
		JSON.stringify(publicKey.export({ format: "jwk" })),
	);
	const toolchain = JSON.stringify({ version: "2026.10.09.1" });
	let manifest: Record<string, unknown> = {};
	let archive = Buffer.alloc(0);
	const server = createServer((request, response) => {
		response.end(
			request.url === "/manifest" ? JSON.stringify(manifest) : archive,
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string")
		throw new Error("test server did not bind");
	// Redirect artifact transport and optionally kill at the real symlink boundary.
	// Child processes verify signatures, bytes and durable transitions themselves.
	const fetchShim = join(directory, "fetch-shim.mjs");
	await writeFile(
		fetchShim,
		`import fs from "node:fs/promises";
		import { syncBuiltinESMExports } from "node:module";
		const originalRename = fs.rename;
		fs.rename = async (source, destination) => {
			await originalRename(source, destination);
			if (process.env.ZUSE_TEST_INTERRUPT_AFTER_SWAP === "1" && destination === process.env.ZUSE_CURRENT_LINK) process.kill(process.pid, "SIGKILL");
		};
		syncBuiltinESMExports();
		const realFetch = globalThis.fetch;
		globalThis.fetch = (url, options) => realFetch(String(url).replace("https://runtime.test", "http://127.0.0.1:${address.port}"), options);`,
	);
	const env = {
		...process.env,
		ZUSE_RELEASES_ROOT: join(directory, "releases"),
		ZUSE_CURRENT_LINK: join(directory, "current"),
		ZUSE_RUNTIME_PUBLIC_KEY_FILE: publicKeyFile,
		ZUSE_RUNTIME_WIRE_PROTOCOL: "6",
		ZUSE_RUNTIME_MANIFEST_URL: `http://127.0.0.1:${address.port}/manifest`,
		ZUSE_RUNTIME_UPDATE_STATUS_FILE: join(directory, "status.json"),
		ZUSE_RUNTIME_SKIP_TOOLCHAIN: "1",
		ZUSE_RUNTIME_UPDATE_TRANSACTION_ID: "operation-1",
	};
	const publish = async (
		version: string,
		options: { invalidToolchain?: boolean } = {},
	) => {
		const source = join(directory, `source-${version}`);
		await mkdir(source);
		await writeFile(
			join(source, "runtime-metadata.json"),
			JSON.stringify({
				schemaVersion: 1,
				appVersion: "0.25.0",
				runtimeVersion: version,
				wireProtocolVersion: 6,
			}),
		);
		await writeFile(join(source, "bin.mjs"), "// fixture runtime\n");
		await writeFile(
			join(source, "toolchain-manifest.json"),
			options.invalidToolchain ? "{}" : toolchain,
		);
		await writeFile(
			join(source, "toolchain-reconciler.mjs"),
			`
			if (process.env.ZUSE_TEST_INTERRUPT === "1") process.kill(process.ppid, "SIGKILL");
		`,
		);
		const archivePath = join(directory, `${version}.tar.gz`);
		await execFileAsync("tar", ["-czf", archivePath, "-C", source, "."]);
		archive = await readFile(archivePath);
		const unsigned = {
			version,
			appVersion: "0.25.0",
			architecture: "linux-x64",
			url: "https://runtime.test/archive",
			sha256: createHash("sha256").update(archive).digest("hex"),
			wireProtocol: { min: 6, max: 6 },
			toolchain: {
				version: "2026.10.09.1",
				sha256: createHash("sha256").update(toolchain).digest("hex"),
			},
		};
		manifest = {
			...unsigned,
			signature: sign(
				null,
				Buffer.from(JSON.stringify(unsigned)),
				privateKey,
			).toString("base64url"),
		};
	};
	return {
		directory,
		env,
		publish,
		invoke: (action: string, extra: Record<string, string> = {}) =>
			execFileAsync(
				process.execPath,
				["--import", fetchShim, updater, ...(action ? [`--${action}`] : [])],
				{ env: { ...env, ...extra } },
			),
		journal: async () =>
			JSON.parse(await readFile(join(directory, "transaction.json"), "utf8")),
		status: async () =>
			JSON.parse(await readFile(join(directory, "status.json"), "utf8")),
		current: () => readlink(env.ZUSE_CURRENT_LINK),
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
};

describe("durable runtime transactions", () => {
	test("prepares signed bytes without changing the installed runtime and only confirms the exact activated generation/version", async () => {
		const fixture = await transactionFixture();
		try {
			const original = join(fixture.directory, "legacy");
			await mkdir(original);
			await symlink(original, fixture.env.ZUSE_CURRENT_LINK);
			await fixture.publish("candidate");
			await fixture.invoke("prepare");
			const prepared = await fixture.journal();
			expect(prepared).toMatchObject({
				phase: "prepared",
				generation: null,
				previous: { release: original, signed: false },
			});
			expect(await fixture.current()).toBe(original);
			await fixture.invoke("prepare");
			expect((await fixture.journal()).createdAt).toBe(prepared.createdAt);
			await fixture.invoke("activate", { ZUSE_RUNTIME_UPDATE_GENERATION: "8" });
			expect(await fixture.current()).toBe(prepared.candidate.release);
			expect(await fixture.status()).toMatchObject({
				state: "updating",
				phase: "verifying",
			});
			expect(JSON.parse((await fixture.invoke("check")).stdout)).toMatchObject({
				state: "updating",
				transactionPhase: "activated",
			});
			await expect(
				fixture.invoke("confirm", {
					ZUSE_RUNTIME_UPDATE_GENERATION: "7",
					ZUSE_RUNTIME_EXPECTED_VERSION: "candidate",
				}),
			).rejects.toThrow();
			await expect(
				fixture.invoke("confirm", {
					ZUSE_RUNTIME_UPDATE_GENERATION: "8",
					ZUSE_RUNTIME_EXPECTED_VERSION: "other",
				}),
			).rejects.toThrow();
			await fixture.invoke("confirm", {
				ZUSE_RUNTIME_UPDATE_GENERATION: "8",
				ZUSE_RUNTIME_EXPECTED_VERSION: "candidate",
			});
			await fixture.invoke("confirm", {
				ZUSE_RUNTIME_UPDATE_GENERATION: "8",
				ZUSE_RUNTIME_EXPECTED_VERSION: "candidate",
			});
			expect(await fixture.journal()).toMatchObject({
				phase: "confirmed",
				confirmedVersion: "candidate",
			});
			expect(await fixture.status()).toMatchObject({
				state: "current",
				phase: "complete",
			});
		} finally {
			await fixture.close();
		}
	});

	test("failed signed staging preserves the current runtime and never creates an activation intent", async () => {
		const fixture = await transactionFixture();
		try {
			const original = join(fixture.directory, "legacy");
			await mkdir(original);
			await symlink(original, fixture.env.ZUSE_CURRENT_LINK);
			await fixture.publish("bad-toolchain", { invalidToolchain: true });
			await expect(fixture.invoke("prepare")).rejects.toMatchObject({
				stderr: expect.stringContaining(
					"Signed toolchain manifest does not match",
				),
			});
			expect(await fixture.current()).toBe(original);
			await expect(fixture.journal()).rejects.toThrow();
		} finally {
			await fixture.close();
		}
	});

	test("retains signed previous release across process boundaries and rolls back under a fresh generation", async () => {
		const fixture = await transactionFixture();
		try {
			await fixture.publish("original");
			await fixture.invoke("prepare");
			await fixture.invoke("activate", { ZUSE_RUNTIME_UPDATE_GENERATION: "2" });
			await fixture.invoke("confirm", {
				ZUSE_RUNTIME_UPDATE_GENERATION: "2",
				ZUSE_RUNTIME_EXPECTED_VERSION: "original",
			});
			const original = await fixture.current();
			await fixture.publish("replacement");
			const operation = { ZUSE_RUNTIME_UPDATE_TRANSACTION_ID: "operation-2" };
			await fixture.invoke("prepare", operation);
			await fixture.invoke("activate", {
				...operation,
				ZUSE_RUNTIME_UPDATE_GENERATION: "3",
			});
			await expect(
				fixture.invoke("prepare", {
					ZUSE_RUNTIME_UPDATE_TRANSACTION_ID: "unrelated",
				}),
			).rejects.toThrow();
			await expect(
				fixture.invoke("rollback", {
					...operation,
					ZUSE_RUNTIME_UPDATE_GENERATION: "3",
				}),
			).rejects.toThrow();
			await expect(
				fixture.invoke("rollback", {
					...operation,
					ZUSE_RUNTIME_UPDATE_GENERATION: "4",
					ZUSE_TEST_INTERRUPT_AFTER_SWAP: "1",
				}),
			).rejects.toThrow();
			expect(await fixture.current()).toBe(original);
			expect(await fixture.journal()).toMatchObject({
				phase: "rolling-back",
				generation: 4,
			});
			await fixture.invoke("rollback", {
				...operation,
				ZUSE_RUNTIME_UPDATE_GENERATION: "4",
			});
			expect(await fixture.current()).toBe(original);
			expect(await fixture.journal()).toMatchObject({
				phase: "rolled-back",
				previous: { version: "original", signed: true },
			});
			expect(await fixture.status()).toMatchObject({ state: "updating" });
			await fixture.invoke("rollback", {
				...operation,
				ZUSE_RUNTIME_UPDATE_GENERATION: "5",
			});
			await expect(
				fixture.invoke("rollback", {
					...operation,
					ZUSE_RUNTIME_UPDATE_GENERATION: "4",
				}),
			).rejects.toThrow();
			expect(await fixture.current()).toBe(original);
			expect(await fixture.journal()).toMatchObject({
				phase: "rolled-back",
				generation: 5,
				previous: { version: "original", signed: true },
			});
			await expect(
				fixture.invoke("confirm", {
					...operation,
					ZUSE_RUNTIME_UPDATE_GENERATION: "5",
					ZUSE_RUNTIME_EXPECTED_VERSION: "replacement",
				}),
			).rejects.toThrow();
			await fixture.invoke("confirm", {
				...operation,
				ZUSE_RUNTIME_UPDATE_GENERATION: "5",
				ZUSE_RUNTIME_EXPECTED_VERSION: "original",
			});
			expect(await fixture.journal()).toMatchObject({
				phase: "confirmed",
				confirmedVersion: "original",
			});
		} finally {
			await fixture.close();
		}
	});

	test("recovers a process killed after its activation intent and permits a newer fenced retry", async () => {
		const fixture = await transactionFixture();
		try {
			await fixture.publish("interrupted");
			await fixture.invoke("prepare");
			await expect(
				fixture.invoke("activate", {
					ZUSE_RUNTIME_UPDATE_GENERATION: "10",
					ZUSE_RUNTIME_SKIP_TOOLCHAIN: "0",
					ZUSE_TEST_INTERRUPT: "1",
				}),
			).rejects.toThrow();
			expect(await fixture.journal()).toMatchObject({
				phase: "activating",
				generation: 10,
			});
			await fixture.invoke("activate", {
				ZUSE_RUNTIME_UPDATE_GENERATION: "11",
			});
			expect(await fixture.journal()).toMatchObject({
				phase: "activated",
				generation: 11,
			});
			await fixture.invoke("activate", {
				ZUSE_RUNTIME_UPDATE_GENERATION: "12",
			});
			await expect(
				fixture.invoke("activate", { ZUSE_RUNTIME_UPDATE_GENERATION: "11" }),
			).rejects.toThrow();
			await expect(
				fixture.invoke("confirm", {
					ZUSE_RUNTIME_UPDATE_GENERATION: "11",
					ZUSE_RUNTIME_EXPECTED_VERSION: "interrupted",
				}),
			).rejects.toThrow();
			await fixture.invoke("confirm", {
				ZUSE_RUNTIME_UPDATE_GENERATION: "12",
				ZUSE_RUNTIME_EXPECTED_VERSION: "interrupted",
			});
		} finally {
			await fixture.close();
		}
	});

	test("recovers activation interrupted after the atomic pointer change", async () => {
		const fixture = await transactionFixture();
		try {
			await fixture.publish("interrupted-swap");
			await fixture.invoke("prepare");
			await expect(
				fixture.invoke("activate", {
					ZUSE_RUNTIME_UPDATE_GENERATION: "15",
					ZUSE_TEST_INTERRUPT_AFTER_SWAP: "1",
				}),
			).rejects.toThrow();
			const journal = await fixture.journal();
			expect(journal).toMatchObject({ phase: "activating", generation: 15 });
			expect(await fixture.current()).toBe(journal.candidate.release);
			await fixture.invoke("activate", {
				ZUSE_RUNTIME_UPDATE_GENERATION: "15",
			});
			expect(await fixture.journal()).toMatchObject({
				phase: "activated",
				generation: 15,
			});
		} finally {
			await fixture.close();
		}
	});

	test("refuses to discard an unreadable journal or restore an unsigned previous release", async () => {
		const fixture = await transactionFixture();
		try {
			const original = join(fixture.directory, "unsigned");
			await mkdir(original);
			await symlink(original, fixture.env.ZUSE_CURRENT_LINK);
			await fixture.publish("signed");
			await fixture.invoke("prepare");
			await fixture.invoke("activate", { ZUSE_RUNTIME_UPDATE_GENERATION: "1" });
			await expect(
				fixture.invoke("rollback", { ZUSE_RUNTIME_UPDATE_GENERATION: "2" }),
			).rejects.toMatchObject({
				stderr: expect.stringContaining(
					"Previous release has no retained signed manifest",
				),
			});
			const candidate = await fixture.current();
			await writeFile(
				join(fixture.directory, "transaction.json"),
				"invalid json",
			);
			await expect(fixture.invoke("prepare")).rejects.toMatchObject({
				stderr: expect.stringContaining("Cannot read runtime update journal"),
			});
			expect(await fixture.current()).toBe(candidate);
		} finally {
			await fixture.close();
		}
	});

	test("stages the installed version alongside an unsigned legacy release directory", async () => {
		const fixture = await transactionFixture();
		try {
			await fixture.publish("same-version");
			const manifest = await (
				await fetch(fixture.env.ZUSE_RUNTIME_MANIFEST_URL)
			).json();
			if (
				typeof manifest !== "object" ||
				manifest === null ||
				!("sha256" in manifest) ||
				typeof manifest.sha256 !== "string"
			) {
				throw new Error("Fixture manifest is missing its SHA-256 digest");
			}
			const original = join(
				fixture.env.ZUSE_RELEASES_ROOT,
				`same-version-${manifest.sha256.slice(0, 12)}`,
			);
			await mkdir(original, { recursive: true });
			await writeFile(
				join(original, "runtime-metadata.json"),
				JSON.stringify({
					schemaVersion: 1,
					runtimeVersion: "same-version",
					appVersion: "0.25.0",
				}),
			);
			await symlink(original, fixture.env.ZUSE_CURRENT_LINK);
			await fixture.invoke("prepare");
			expect(await fixture.current()).toBe(original);
			const journal = await fixture.journal();
			expect(journal).toMatchObject({
				phase: "prepared",
				candidate: { version: "same-version" },
				previous: { release: original, signed: false },
			});
			expect(journal.candidate.release).not.toBe(original);
		} finally {
			await fixture.close();
		}
	});

	test("legacy install-only activation remains unconfirmed", async () => {
		const fixture = await transactionFixture();
		try {
			await fixture.publish("legacy-install");
			await fixture.invoke("", { ZUSE_RUNTIME_INSTALL_ONLY: "1" });
			expect(await fixture.journal()).toMatchObject({
				phase: "activated",
				generation: null,
			});
			expect(await fixture.status()).toMatchObject({
				state: "updating",
				phase: "verifying",
			});
			const baseline = await fixture.current();
			await fixture.invoke("prepare", {
				ZUSE_RUNTIME_UPDATE_TRANSACTION_ID: "workspace-operation",
			});
			expect(await fixture.current()).toBe(baseline);
			expect(await fixture.journal()).toMatchObject({
				phase: "prepared",
				generation: null,
				transactionId: "workspace-operation",
				previous: { release: baseline, signed: true },
			});
			expect(await fixture.status()).toMatchObject({ state: "updating" });
			await expect(
				fixture.invoke("prepare", {
					ZUSE_RUNTIME_UPDATE_TRANSACTION_ID: "unrelated-workspace-operation",
				}),
			).rejects.toThrow();
		} finally {
			await fixture.close();
		}
	});
});
