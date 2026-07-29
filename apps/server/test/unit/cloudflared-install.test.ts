import { describe, expect, test } from "vitest";

import {
	cloudflaredAsset,
	verifySha256,
} from "../../src/relay/cloudflared-install.ts";

describe("cloudflared installer", () => {
	test("pins supported platform assets and checksums", () => {
		expect(cloudflaredAsset("darwin", "arm64")).toMatchObject({
			version: "2026.7.2",
			name: "cloudflared-darwin-arm64.tgz",
			sha256:
				"0588df58494a6cadd38b9deb6078908a5054063c80784d92fdb8d4a5f3de1c67",
		});
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
