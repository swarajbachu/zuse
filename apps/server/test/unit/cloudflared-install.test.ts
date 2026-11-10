import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
	cloudflaredAsset,
	ensurePinnedCloudflared,
	verifySha256,
} from "../../src/api/cloudflared-install.ts";

describe("cloudflared installer", () => {
	test.each([
		{
			architecture: "x64",
			name: "cloudflared-darwin-amd64.tgz",
			sha256:
				"4ee0d3b48a990a2f9b5faec5838f73ec1f400aa8e0a4864be576adfafec406cb",
		},
		{
			architecture: "arm64",
			name: "cloudflared-darwin-arm64.tgz",
			sha256:
				"2086e51c61d6565781d84117a5007d0c826d03ffdc74acb91c08c167f9f8cd7c",
		},
	])("pins the published macOS $architecture archive digest", (asset) => {
		// GitHub release asset digests hash the .tgz, unlike the release notes,
		// which list the extracted macOS executable digests for this release.
		expect(cloudflaredAsset("darwin", asset.architecture)).toMatchObject({
			version: "2026.7.2",
			name: asset.name,
			sha256: asset.sha256,
			archive: true,
		});
	});

	test("pins the Linux binary checksum", () => {
		expect(cloudflaredAsset("linux", "x64")).toMatchObject({
			name: "cloudflared-linux-amd64",
			sha256:
				"ec905ea7b7e327ff8abdde8cb64697a2152de74dbcdbf6aec9db8364eb3886cd",
		});
	});

	test("rejects unsupported operating systems and architectures", () => {
		expect(() => cloudflaredAsset("win32", "x64")).toThrow(
			/unsupported platform/i,
		);
		expect(() => cloudflaredAsset("linux", "riscv64")).toThrow(
			/unsupported architecture/i,
		);
	});

	test("rejects content whose checksum does not match", () => {
		expect(() => verifySha256(Buffer.from("tampered"), "0".repeat(64))).toThrow(
			/checksum mismatch/i,
		);
	});
});

test("cancels a pending installer download when its owner closes", async () => {
	const userData = await mkdtemp(join(tmpdir(), "zuse-installer-cancel-"));
	const owner = new AbortController();
	let requestSignal: AbortSignal | null | undefined;
	let started!: () => void;
	const pending = new Promise<void>((resolve) => {
		started = resolve;
	});
	const download = ensurePinnedCloudflared({
		userData,
		platform: "linux",
		architecture: "x64",
		signal: owner.signal,
		fetcher: (async (_url, options) => {
			requestSignal = options?.signal;
			started();
			return new Promise<Response>((_resolve, reject) =>
				requestSignal?.addEventListener("abort", () =>
					reject(requestSignal?.reason),
				),
			);
		}) as typeof fetch,
	});

	const result = download.catch((cause) => cause);
	try {
		await pending;
		owner.abort(new Error("runtime closed"));
		expect(requestSignal?.aborted).toBe(true);
		expect(await result).toMatchObject({ message: "runtime closed" });
	} finally {
		await rm(userData, { recursive: true, force: true });
	}
});
