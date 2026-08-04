import { describe, expect, test } from "vitest";

import { resolveDownloadTarget, selectReleaseAsset } from "./download";

describe("resolveDownloadTarget", () => {
	test("selects the macOS installer for a desktop Mac browser", () => {
		expect(
			resolveDownloadTarget({
				platform: null,
				format: null,
				userAgent:
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
			}),
		).toBe("macos");
	});

	test("selects the AppImage for a desktop Linux browser", () => {
		expect(
			resolveDownloadTarget({
				platform: null,
				format: null,
				userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
			}),
		).toBe("linux-appimage");
	});

	test("supports an explicit Linux deb request", () => {
		expect(
			resolveDownloadTarget({
				platform: "linux",
				format: "deb",
				userAgent: null,
			}),
		).toBe("linux-deb");
	});

	test("does not send mobile or unsupported clients a desktop installer", () => {
		expect(
			resolveDownloadTarget({
				platform: null,
				format: null,
				userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 10)",
			}),
		).toBeNull();
		expect(
			resolveDownloadTarget({
				platform: null,
				format: null,
				userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
			}),
		).toBeNull();
	});
});

describe("selectReleaseAsset", () => {
	const assets = [
		{
			name: "Zuse-0.16.0-universal.dmg.blockmap",
			browser_download_url: "https://example.com/mac.blockmap",
		},
		{
			name: "Zuse-0.16.0-universal.dmg",
			browser_download_url: "https://example.com/mac.dmg",
		},
		{
			name: "Zuse-0.16.0-linux-x86_64.AppImage",
			browser_download_url: "https://example.com/linux.AppImage",
		},
		{
			name: "Zuse-0.16.0-linux-amd64.deb",
			browser_download_url: "https://example.com/linux.deb",
		},
	];

	test("selects the requested installer format", () => {
		expect(selectReleaseAsset(assets, "macos")?.name).toMatch(/\.dmg$/);
		expect(selectReleaseAsset(assets, "linux-appimage")?.name).toMatch(
			/\.AppImage$/,
		);
		expect(selectReleaseAsset(assets, "linux-deb")?.name).toMatch(/\.deb$/);
	});

	test("returns null when the release does not contain the requested format", () => {
		expect(selectReleaseAsset([], "linux-appimage")).toBeNull();
	});
});
