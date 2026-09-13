import { AppImageUpdater } from "electron-updater";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor.js";
import { describe, expect, it, vi } from "vitest";
import { channelProvider } from "../../src/update-provider.ts";

const options = { provider: "github", owner: "example", repo: "app" } as const;
function fixture(
	channel: "stable" | "preview",
	versions: string[],
	installed = "0.21.0",
) {
	const updater = new AppImageUpdater(undefined, {
		version: installed,
		name: "Zuse",
		isPackaged: true,
	});
	updater.channel = channel === "stable" ? "latest" : "preview";
	updater.allowPrerelease = channel === "preview";
	updater.allowDowngrade =
		channel === "stable" && installed.includes("preview");
	const executor = new ElectronHttpExecutor();
	const request = vi
		.spyOn(executor, "request")
		.mockImplementation(async (request) => {
			const path = request.path ?? "";
			if (path.endsWith(".atom"))
				return `<feed>${versions.map((version) => `<entry><title>${version}</title><link href="https://github.com/example/app/releases/tag/v${version}"/><content>Notes ${version}</content></entry>`).join("")}</feed>`;
			if (path.endsWith("/latest"))
				return JSON.stringify({
					tag_name: `v${versions.find((version) => !version.includes("-"))}`,
				});
			const version = versions.find((version) =>
				path.includes(`/v${version}/`),
			);
			if (!version) throw new Error(`Unexpected request: ${path}`);
			return `version: ${version}\nfiles:\n  - url: Zuse-${version}.AppImage\n    sha512: aGVsbG8=\n    size: 5\n`;
		});
	const Provider = channelProvider(options, () => channel);
	const provider = new Provider({}, updater, {
		executor,
		platform: "linux",
		isUseMultipleRangeRequest: false,
	});
	return { provider, updater, request };
}

describe("GitHub release channels", () => {
	it("Stable ignores newer Preview releases", async () => {
		const { provider, updater } = fixture(
			"stable",
			["0.22.0-preview.1", "0.21.0"],
			"0.22.0-preview.1",
		);
		expect((await provider.getLatestVersion()).version).toBe("0.21.0");
		expect(updater.allowDowngrade).toBe(true);
		expect(updater.channel).toBe("latest");
		expect(updater.allowPrerelease).toBe(false);
	});
	it("Preview receives the newer Preview and restores the update policy", async () => {
		const { provider, updater } = fixture("preview", [
			"0.22.0-preview.10",
			"0.21.0",
		]);
		expect((await provider.getLatestVersion()).version).toBe(
			"0.22.0-preview.10",
		);
		expect(updater.allowDowngrade).toBe(false);
		expect(updater.channel).toBe("preview");
	});
	it("Preview receives a newer Stable without losing its preference", async () => {
		const { provider, updater } = fixture("preview", [
			"0.22.0",
			"0.22.0-preview.10",
		]);
		expect((await provider.getLatestVersion()).version).toBe("0.22.0");
		expect(updater.channel).toBe("preview");
	});
	it("falls back to Stable when no Preview exists, but surfaces network failure", async () => {
		const { provider, updater, request } = fixture("preview", ["0.21.0"]);
		expect((await provider.getLatestVersion()).version).toBe("0.21.0");
		request.mockRejectedValue(new Error("network offline"));
		await expect(provider.getLatestVersion()).rejects.toThrow(
			"network offline",
		);
		expect(updater.channel).toBe("preview");
		expect(updater.allowDowngrade).toBe(false);
	});
});
