import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPDATE_CHANNEL_SET } from "@zuse/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	directory: "",
	version: "0.22.0-preview.1",
	target: "0.22.0-preview.2",
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	finishDownload: () => {},
	cancelDownload: vi.fn(),
	hold: false,
}));
vi.mock("electron", () => ({
	app: {
		getPath: () => state.directory,
		getVersion: () => state.version,
		isPackaged: true,
		exit: vi.fn(),
	},
	ipcMain: {
		handle: (name: string, fn: (...args: unknown[]) => unknown) =>
			state.handlers.set(name, fn),
	},
}));
vi.mock("electron-updater", async () => {
	const { EventEmitter } = await import("node:events");
	class CancellationToken {
		cancelled = false;
		cancel() {
			this.cancelled = true;
			state.cancelDownload();
		}
	}
	const autoUpdater = Object.assign(new EventEmitter(), {
		logger: {},
		autoDownload: true,
		autoInstallOnAppQuit: true,
		channel: "latest",
		allowPrerelease: false,
		allowDowngrade: false,
		setFeedURL: vi.fn(),
		quitAndInstall: vi.fn(),
		checkForUpdates: vi.fn(async () => {
			autoUpdater.emit("checking-for-update");
			autoUpdater.emit("update-available", { version: state.target });
			return { updateInfo: { version: state.target } };
		}),
		downloadUpdate: vi.fn(async (_token: CancellationToken) => {
			if (state.hold)
				await new Promise<void>((resolve) => {
					state.finishDownload = resolve;
				});
			autoUpdater.emit("update-downloaded", { version: state.target });
			return [];
		}),
	});
	return { autoUpdater, CancellationToken };
});
vi.mock("../../src/update-provider.ts", () => ({ channelProvider: vi.fn() }));

beforeEach(async () => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.useFakeTimers();
	state.handlers.clear();
	state.hold = false;
	state.target = "0.22.0-preview.2";
	state.directory = await mkdtemp(join(tmpdir(), "zuse-updater-integration-"));
	Object.defineProperty(process, "resourcesPath", {
		configurable: true,
		value: state.directory,
	});
	await writeFile(
		join(state.directory, "app-update.yml"),
		"provider: github\nowner: example\nrepo: app\n",
	);
});
afterEach(async () => {
	vi.useRealTimers();
	await rm(state.directory, { recursive: true, force: true });
});

async function start() {
	const { startAutoUpdater, ...updater } = await import("../../src/updater.ts");
	const { autoUpdater } = await import("electron-updater");
	// Only the renderer attachment surface is needed by the updater.
	const window = {
		isDestroyed: () => false,
		webContents: { send: vi.fn(), on: vi.fn() },
	};
	startAutoUpdater(window);
	return { ...updater, autoUpdater };
}

describe("updater channel lifecycle", () => {
	it("revokes a downloaded Preview before a switch and installs only the new Stable download", async () => {
		const updater = await start();
		await vi.waitFor(() => expect(updater.getLastStatus().kind).toBe("ready"));
		state.hold = true;
		state.target = "0.21.0";
		const changed = state.handlers.get(UPDATE_CHANNEL_SET)?.({}, "stable");
		await changed;
		updater.installUpdate();
		expect(updater.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
		await vi.waitFor(() =>
			expect(updater.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(2),
		);
		expect(updater.autoUpdater.allowDowngrade).toBe(true);
		state.finishDownload();
		await vi.waitFor(() =>
			expect(updater.getLastStatus()).toEqual({
				kind: "ready",
				version: "0.21.0",
			}),
		);
		updater.installUpdate();
		expect(updater.autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
	});
	it("cancels an active transfer and ignores its late completion during a channel change", async () => {
		state.hold = true;
		const updater = await start();
		await vi.waitFor(() =>
			expect(updater.autoUpdater.downloadUpdate).toHaveBeenCalledOnce(),
		);
		const changed = state.handlers.get(UPDATE_CHANNEL_SET)?.({}, "stable");
		await vi.waitFor(() => expect(state.cancelDownload).toHaveBeenCalledOnce());
		state.finishDownload();
		await changed;
		expect(updater.getLastStatus().kind).not.toBe("ready");
		updater.installUpdate();
		expect(updater.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
		state.hold = false;
		await vi.waitFor(() =>
			expect(updater.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(2),
		);
		state.finishDownload();
	});
	it("does not authorize downgrade just because a Preview build has no preference file", async () => {
		const updater = await start();
		await vi.waitFor(() => expect(updater.getLastStatus().kind).toBe("ready"));
		expect(updater.autoUpdater.allowDowngrade).toBe(false);
	});
});
