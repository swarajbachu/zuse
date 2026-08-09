import { execFile } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
	test("matches the installed runtime against the desktop app target", async () => {
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
			const result = await execFileAsync(
				process.execPath,
				[
					join(import.meta.dirname, "../../scripts/runtime-updater.mjs"),
					"--check",
				],
				{
					env: {
						...process.env,
						ZUSE_CURRENT_LINK: current,
						ZUSE_RUNTIME_MANIFEST_URL: `http://127.0.0.1:${address.port}/manifest`,
						ZUSE_RUNTIME_PUBLIC_KEY_FILE: publicKeyFile,
						ZUSE_RUNTIME_WIRE_PROTOCOL: "4",
						ZUSE_RUNTIME_DESIRED_APP_VERSION: "0.17.1",
					},
				},
			);
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
	});
});
