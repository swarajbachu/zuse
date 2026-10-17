import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	UPDATE_CHANNEL_GET,
	UPDATE_CHANNEL_SET,
	UPDATE_CHECK_CHANNEL,
	UPDATE_DOWNLOAD_CHANNEL,
	UPDATE_INSTALL_CHANNEL,
	UPDATE_STATUS_CHANNEL,
	type UpdateStatus,
} from "@zuse/contracts";
import { parseReleaseVersion } from "@zuse/utils/release-version";
import {
	app,
	type BrowserWindow,
	ipcMain,
	autoUpdater as nativeUpdater,
} from "electron";
import {
	autoUpdater,
	CancellationToken,
	type ProgressInfo,
	type UpdateInfo,
} from "electron-updater";
import { parse } from "yaml";
import {
	readUpdatePreference,
	UpdateChannelCoordinator,
	writeUpdateChannel,
} from "./update-channel.ts";
import { channelProvider } from "./update-provider.ts";
import {
	automaticUpdateRetryDelay,
	isTransientUpdateCheckError,
	updateCheckErrorMessage,
	updateDownloadErrorMessage,
} from "./updater-errors.ts";
import {
	shouldAutoInstallUpdateOnQuit,
	shouldInstallPendingUpdateOnQuit,
} from "./updater-policy.ts";

let downgradeFrom: string | undefined;
const coordinator = new UpdateChannelCoordinator(
	async (channel) => {
		const version =
			channel === "stable" &&
			parseReleaseVersion(app.getVersion()).preview !== null
				? app.getVersion()
				: undefined;
		await writeUpdateChannel(app.getPath("userData"), channel, version);
		downgradeFrom = version;
	},
	() => {
		autoUpdater.autoInstallOnAppQuit = false;
		clearAutomaticCheckRetry();
		clearStallTimer();
		emit({ kind: "idle" });
	},
);
let initialization = Promise.resolve();
let downloadToken: CancellationToken | null = null;

type UpdaterWindow = Pick<BrowserWindow, "isDestroyed"> & {
	webContents: Pick<BrowserWindow["webContents"], "send" | "on">;
};

const UPDATE_POLL_MS = 6 * 60 * 60 * 1000;

// If no `download-progress` event fires for this long while in the
// `downloading` state, treat the download as stalled. electron-updater itself
// doesn't fire any "stuck" event — the underlying request just hangs — so
// the toast and menu would otherwise sit forever showing the last percent.
const DOWNLOAD_STALL_MS = 60_000;

const NATIVE_STAGING_TIMEOUT_MS = 3 * 60_000;

let lastStatus: UpdateStatus = { kind: "idle" };
let started = false;
let activeUpdateCheck: "automatic" | "manual" | null = null;
let updateCheckInFlight: Promise<void> | null = null;
let automaticCheckRetryTimer: NodeJS.Timeout | null = null;

let installingUpdate = false;
let preparingEngine = false;
let enginePreparationFailure: { readonly error: unknown } | null = null;
let skipPendingInstallOnce = false;
let engineUpdateLifecycle: {
	prepare: () => Promise<"stopped" | "busy">;
	resume: () => void;
} | null = null;

/** All update entry points must release the independent engine before replacing its files. */
export function setEngineUpdateLifecycle(
	lifecycle: NonNullable<typeof engineUpdateLifecycle>,
): void {
	engineUpdateLifecycle = lifecycle;
}

let nativeStage: {
	kind: "pending" | "timed-out" | "ready";
	version: string;
} | null = null;

function updateFeedLocked(): boolean {
	return preparingEngine || installingUpdate || nativeStage !== null;
}

/**
 * True once `installUpdate()` has kicked off the quit-and-install sequence.
 * The main-process quit handler uses this to finish native resource cleanup.
 */
export function getIsInstallingUpdate(): boolean {
	return installingUpdate;
}

/**
 * All platforms wait for a safe engine shutdown before installation. On
 * macOS we deliberately do not let electron-updater hand a download to
 * Squirrel until the app is actually quitting. Squirrel keeps the first
 * staged update for the lifetime of the process, which otherwise means a
 * newer release discovered later cannot replace it.
 *
 * Returns true when the caller must prevent the current quit event. The
 * updater will start a fresh quit after Squirrel has staged the latest file.
 */
export function installPendingUpdateOnQuit(): boolean {
	if (skipPendingInstallOnce) {
		skipPendingInstallOnce = false;
		return false;
	}
	if (preparingEngine) return true;
	if (
		!shouldInstallPendingUpdateOnQuit({
			platform: process.platform,
			status: lastStatus,
			installing: installingUpdate,
		})
	) {
		return false;
	}

	void installUpdate(true);
	return true;
}

/**
 * Single entry point for "quit, install the downloaded update, relaunch".
 * Both the renderer IPC (`UPDATE_INSTALL_CHANNEL`) and the native menu route
 * through here so engine shutdown finishes before any native installer can
 * replace the executable files. Busy engines continue independently of the UI.
 */
export async function installUpdate(quitIfBusy = false): Promise<void> {
	if (
		coordinator.switching ||
		preparingEngine ||
		lastStatus.kind !== "ready" ||
		installingUpdate ||
		(nativeStage !== null && nativeStage.kind !== "ready")
	)
		return;
	preparingEngine = true;
	enginePreparationFailure = null;
	try {
		if (engineUpdateLifecycle === null)
			throw new Error("The engine update lifecycle is unavailable.");
		const result = await engineUpdateLifecycle.prepare();
		const failure = readEnginePreparationFailure();
		if (failure !== null) throw failure.error;
		if (result === "busy") {
			engineUpdateLifecycle.resume();
			if (quitIfBusy) {
				preparingEngine = false;
				skipPendingInstallOnce = true;
				app.quit();
			} else
				emit({
					kind: "error",
					message:
						"Active engine work must finish before this update can be installed.",
					retryable: true,
				});
			return;
		}
	} catch (error) {
		preparingEngine = false;
		if (quitIfBusy) {
			engineUpdateLifecycle?.resume();
			skipPendingInstallOnce = true;
			app.quit();
		} else failUpdateInstall(error);
		return;
	} finally {
		preparingEngine = false;
	}
	installingUpdate = true;
	clearAutomaticCheckRetry();
	try {
		if (process.platform === "darwin") {
			// electron-updater has prepared a local ZIP feed, but Squirrel still
			// needs to fetch, unpack, and validate it. Own the native callbacks so
			// a failed attempt cannot leave a stale quit callback on a later retry.
			nativeUpdater.once("before-quit-for-update", armInstallExitWatchdog);
			if (nativeStage?.kind === "ready") {
				nativeUpdater.quitAndInstall();
				return;
			}
			nativeStage = { kind: "pending", version: lastStatus.version };
			nativeUpdater.once("update-not-available", nativeStagingUnavailable);
			nativeUpdater.once("update-downloaded", quitAfterNativeStaging);
			nativeStagingTimer = setTimeout(
				nativeStagingTimedOut,
				NATIVE_STAGING_TIMEOUT_MS,
			);
			nativeStagingTimer.unref();
			nativeUpdater.checkForUpdates();
		} else {
			autoUpdater.quitAndInstall();
			if (installingUpdate) armInstallExitWatchdog();
		}
	} catch (error) {
		failUpdateInstall(error);
	}
}

let installExitTimer: NodeJS.Timeout | null = null;
let nativeStagingTimer: NodeJS.Timeout | null = null;

function nativeStagingTimedOut(): void {
	clearNativeStagingTimer();
	if (nativeStage?.kind !== "pending") return;
	nativeStage.kind = "timed-out";
	installingUpdate = false;
	engineUpdateLifecycle?.resume();
	nativeUpdater.removeListener(
		"before-quit-for-update",
		armInstallExitWatchdog,
	);
	emit({
		kind: "error",
		message:
			"Update preparation is taking longer than expected. Wait, or restart Zuse to try again.",
		retryable: false,
	});
}

function nativeStagingUnavailable(): void {
	failUpdateInstall(new Error("The native updater found no update to stage"));
}

function clearNativeStagingTimer(): void {
	if (nativeStagingTimer !== null) clearTimeout(nativeStagingTimer);
	nativeStagingTimer = null;
}

function armInstallExitWatchdog(): void {
	if (installExitTimer !== null || !installingUpdate) return;

	installExitTimer = setTimeout(() => {
		console.warn(
			"[zuse:updater] shutdown stalled after installer handoff — forcing exit",
		);
		app.exit(0);
	}, 4000);
	installExitTimer.unref();
}

function quitAfterNativeStaging(): void {
	clearNativeStagingTimer();
	nativeUpdater.removeListener(
		"update-not-available",
		nativeStagingUnavailable,
	);
	if (nativeStage === null) return;
	const timedOut = nativeStage.kind === "timed-out";
	nativeStage.kind = "ready";
	if (timedOut) {
		emit({ kind: "ready", version: nativeStage.version });
		return;
	}
	try {
		nativeUpdater.quitAndInstall();
	} catch (error) {
		failUpdateInstall(error);
	}
}

function readEnginePreparationFailure(): { readonly error: unknown } | null {
	return enginePreparationFailure;
}

function failUpdateInstall(error: unknown): void {
	if (preparingEngine) {
		enginePreparationFailure = { error };
		return;
	}
	clearNativeStagingTimer();
	if (nativeStage?.kind !== "ready") nativeStage = null;
	if (installExitTimer !== null) clearTimeout(installExitTimer);
	installExitTimer = null;
	if (process.platform === "darwin") {
		nativeUpdater.removeListener(
			"before-quit-for-update",
			armInstallExitWatchdog,
		);
		nativeUpdater.removeListener("update-downloaded", quitAfterNativeStaging);
		nativeUpdater.removeListener(
			"update-not-available",
			nativeStagingUnavailable,
		);
	}
	installingUpdate = false;
	engineUpdateLifecycle?.resume();
	console.error("[zuse:updater] install failed", error);
	emit({
		kind: "error",
		message: "Couldn’t install the update. Try again.",
		retryable: true,
	});
}

const statusListeners = new Set<(status: UpdateStatus) => void>();

let stallTimer: NodeJS.Timeout | null = null;

let stallRetried = false;

function clearStallTimer(): void {
	if (stallTimer !== null) {
		clearTimeout(stallTimer);
		stallTimer = null;
	}
}

function armStallTimer(): void {
	clearStallTimer();
	stallTimer = setTimeout(() => {
		stallTimer = null;
		if (lastStatus.kind !== "downloading" && lastStatus.kind !== "available")
			return;

		downloadToken?.cancel();
	}, DOWNLOAD_STALL_MS);
}

function emit(status: UpdateStatus): void {
	lastStatus = status;
	for (const listener of statusListeners) {
		try {
			listener(status);
		} catch (err) {
			console.error("[zuse:updater] listener threw", err);
		}
	}
}

function clearAutomaticCheckRetry(): void {
	if (automaticCheckRetryTimer === null) return;
	clearTimeout(automaticCheckRetryTimer);
	automaticCheckRetryTimer = null;
}

function scheduleAutomaticCheckRetry(
	failedAttempt: number,
	delayMs: number,
): void {
	clearAutomaticCheckRetry();
	console.warn(
		`[zuse:updater] automatic check failed — retrying in ${delayMs}ms`,
	);
	automaticCheckRetryTimer = setTimeout(() => {
		automaticCheckRetryTimer = null;
		void runUpdateCheck("automatic", failedAttempt + 1);
	}, delayMs);
	automaticCheckRetryTimer.unref();
}

function runUpdateCheck(
	kind: "automatic" | "manual",
	attempt = 0,
): Promise<void> {
	if (updateFeedLocked()) {
		if (!installingUpdate && nativeStage?.kind === "ready")
			emit({ kind: "ready", version: nativeStage.version });
		return Promise.resolve();
	}
	if (kind === "manual") clearAutomaticCheckRetry();
	if (updateCheckInFlight !== null) return updateCheckInFlight;

	activeUpdateCheck = kind;
	let downloading = false;
	const operation = initialization
		.then(() =>
			coordinator.run(
				async () => {
					if (updateFeedLocked()) return;
					configureChannel();
					const result = await autoUpdater.checkForUpdates();
					if (
						!coordinator.switching &&
						lastStatus.kind === "available" &&
						result !== null
					) {
						downloading = true;
						await downloadUpdate();
					}
				},
				() => downloadToken?.cancel(),
			),
		)
		.catch((error: unknown) => {
			if (coordinator.switching) return;
			const retryDelay =
				kind === "automatic" && isTransientUpdateCheckError(error)
					? automaticUpdateRetryDelay(attempt)
					: null;
			if (retryDelay !== null) {
				console.warn("[zuse:updater] transient automatic check failure", error);
				scheduleAutomaticCheckRetry(attempt, retryDelay);
				return;
			}
			console.error("[zuse:updater] check failed", error);
			emit({
				kind: "error",
				message: downloading
					? updateDownloadErrorMessage(error)
					: updateCheckErrorMessage(error),
				retryable: true,
			});
		})
		.finally(() => {
			activeUpdateCheck = null;
			updateCheckInFlight = null;
		});
	updateCheckInFlight = operation;
	return operation;
}

/**
 * Snapshot of the latest update status. Menu rebuilds read this; everyone
 * else should subscribe via `onStatusChange` instead of polling.
 */
export function getLastStatus(): UpdateStatus {
	return lastStatus;
}

/**
 * Subscribe to status transitions. Returns an unsubscribe function. The
 * native menu uses this to rebuild itself so the "Check for Updates…" item
 * label tracks the live state even when the renderer toast is dismissed.
 */
export function onStatusChange(
	listener: (status: UpdateStatus) => void,
): () => void {
	statusListeners.add(listener);
	return () => {
		statusListeners.delete(listener);
	};
}

function attachRenderer(window: UpdaterWindow): void {
	const sendToRenderer = (status: UpdateStatus) => {
		if (window.isDestroyed()) return;
		window.webContents.send(UPDATE_STATUS_CHANNEL, status);
	};
	statusListeners.add(sendToRenderer);
	window.webContents.on("did-finish-load", () => sendToRenderer(lastStatus));
}

export function startAutoUpdater(window: UpdaterWindow): void {
	attachRenderer(window);

	if (started) return;
	started = true;

	autoUpdater.logger = {
		info: (msg: unknown) => console.log("[zuse:updater]", msg),
		warn: (msg: unknown) => console.warn("[zuse:updater]", msg),
		error: (msg: unknown) => console.error("[zuse:updater]", msg),
		debug: () => {},
	} as unknown as typeof autoUpdater.logger;

	autoUpdater.autoDownload = false;
	// Squirrel.Mac cannot supersede an update it has already staged during the
	// current process. Keep downloads in electron-updater's replaceable cache
	// on macOS, then stage the latest one from the before-quit handler. Other
	// platforms can safely retain electron-updater's normal install-on-quit.
	autoUpdater.autoInstallOnAppQuit = false;
	initialization = initializeChannels(true);
	registerChannelHandlers();

	autoUpdater.on("checking-for-update", () => {
		if (coordinator.switching) return;
		clearStallTimer();
		emit({ kind: "checking" });
	});
	autoUpdater.on("update-available", (info: UpdateInfo) => {
		if (coordinator.switching) return;
		clearStallTimer();
		emit({
			kind: "available",
			version: info.version,
			releaseNotes:
				typeof info.releaseNotes === "string" ? info.releaseNotes : undefined,
			releaseDate: info.releaseDate,
		});
	});
	autoUpdater.on("update-not-available", () => {
		if (coordinator.switching) return;
		clearStallTimer();
		emit({ kind: "not-available" });
	});
	autoUpdater.on("download-progress", (p: ProgressInfo) => {
		if (coordinator.switching) return;
		armStallTimer();
		emit({
			kind: "downloading",
			percent: p.percent,
			bytesPerSecond: p.bytesPerSecond,
		});
	});
	autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
		if (coordinator.switching) return;
		clearStallTimer();
		autoUpdater.autoInstallOnAppQuit = shouldAutoInstallUpdateOnQuit(
			process.platform,
		);
		emit({ kind: "ready", version: info.version });
	});
	autoUpdater.on("error", (err: Error) => {
		if (coordinator.switching) return;
		clearStallTimer();
		if (updateFeedLocked()) {
			failUpdateInstall(err);
			return;
		}

		if (activeUpdateCheck !== null) return;
		emit({
			kind: "error",
			message: updateDownloadErrorMessage(err),
			retryable: true,
		});
	});

	ipcMain.handle(UPDATE_CHECK_CHANNEL, async () => {
		await runUpdateCheck("manual");
	});
	ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, async () => {
		await runUpdateCheck("manual");
	});
	ipcMain.handle(UPDATE_INSTALL_CHANNEL, () => {
		installUpdate();
	});

	const check = () => {
		void runUpdateCheck("automatic");
	};
	check();
	setInterval(check, UPDATE_POLL_MS);
}

/**
 * Imperative entrypoints for the native menu. These bypass the renderer-bound
 * IPC bridge (`window.zuse.updates.*`) because menu clicks run in main —
 * routing through IPC would just bounce back to the same `autoUpdater` calls.
 */
export function triggerUpdateCheck(): void {
	void runUpdateCheck("manual");
}

export function triggerUpdateDownload(): void {
	void runUpdateCheck("manual");
}

export function triggerUpdateInstall(): void {
	installUpdate();
}

/**
 * Dev-only IPC bridge for previewing the update banner without cutting a real
 * release. `window.__zuseUpdateDemo.set(status)` in the renderer round-trips
 * through `zuse:update-demo-set`, which re-broadcasts on the same channel
 * the real updater uses — so the banner sees indistinguishable payloads.
 *
 * Call from `main.ts` only when `isDevelopment`. No-op in packaged builds.
 */
export function registerUpdaterDemo(window: UpdaterWindow): void {
	attachRenderer(window);
	if (started) return;
	started = true;
	initialization = initializeChannels(false);
	registerChannelHandlers();
	ipcMain.handle("zuse:update-demo-set", (_event, status: UpdateStatus) => {
		emit(status);
	});
}

function configureChannel(): void {
	autoUpdater.channel = coordinator.channel === "stable" ? "latest" : "preview";
	autoUpdater.allowPrerelease = coordinator.channel === "preview";

	autoUpdater.allowDowngrade =
		coordinator.channel === "stable" &&
		downgradeFrom === app.getVersion() &&
		parseReleaseVersion(app.getVersion()).preview !== null;
}

async function initializeChannels(packaged: boolean): Promise<void> {
	const preference = await readUpdatePreference(app.getPath("userData"));
	coordinator.channel = preference.channel;
	downgradeFrom = preference.downgradeFrom;
	if (packaged) {
		const options = parse(
			await readFile(join(process.resourcesPath, "app-update.yml"), "utf8"),
		);
		if (
			options?.provider !== "github" ||
			typeof options.owner !== "string" ||
			typeof options.repo !== "string"
		)
			throw new Error("Desktop channels require the GitHub release provider");
		autoUpdater.setFeedURL({
			provider: "custom",
			updateProvider: channelProvider(
				{ provider: "github", owner: options.owner, repo: options.repo },
				() => coordinator.channel,
			),
		});
		configureChannel();
	}
}

function registerChannelHandlers(): void {
	ipcMain.handle(UPDATE_CHANNEL_GET, async () => {
		await initialization;
		return coordinator.channel;
	});
	ipcMain.handle(UPDATE_CHANNEL_SET, async (_event, channel: unknown) => {
		await initialization;
		if (updateFeedLocked())
			throw new Error(
				"An update is already installing. Restart Zuse before changing channels.",
			);
		await coordinator.setChannel(channel);
		await updateCheckInFlight;
		if (app.isPackaged) void runUpdateCheck("manual");
		return coordinator.channel;
	});
}

async function downloadUpdate(): Promise<void> {
	stallRetried = false;
	while (!coordinator.switching) {
		downloadToken = new CancellationToken();
		armStallTimer();
		try {
			await autoUpdater.downloadUpdate(downloadToken);
			return;
		} catch (error) {
			if (coordinator.switching) return;
			if (downloadToken.cancelled && !stallRetried) {
				stallRetried = true;
				continue;
			}
			throw error;
		} finally {
			clearStallTimer();
			downloadToken = null;
		}
	}
}
