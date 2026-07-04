import { ipcMain, type BrowserWindow } from "electron";
import {
  autoUpdater,
  type ProgressInfo,
  type UpdateInfo,
} from "electron-updater";

import {
  UPDATE_CHECK_CHANNEL,
  UPDATE_DOWNLOAD_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_STATUS_CHANNEL,
  type UpdateStatus,
} from "@zuse/wire";

// electron-updater talks to the GitHub Releases feed configured in
// apps/desktop/electron-builder.yml (`publish.provider: github`). It reads
// `latest-mac.yml` from the latest *published* release (drafts are invisible
// to unauthenticated readers — see release flow note in electron-builder.yml),
// compares versions, and downloads the .dmg. We drive the lifecycle manually
// so the renderer can show download progress + a "Restart now" button instead
// of relying on the system notification center.
//
// Re-poll every six hours so a long-running session picks up a release
// pushed mid-week without requiring a manual restart-to-check.
const UPDATE_POLL_MS = 6 * 60 * 60 * 1000;

// If no `download-progress` event fires for this long while in the
// `downloading` state, treat the download as stalled. electron-updater itself
// doesn't fire any "stuck" event — the underlying request just hangs — so
// the toast and menu would otherwise sit forever showing the last percent.
const DOWNLOAD_STALL_MS = 60_000;

let lastStatus: UpdateStatus = { kind: "idle" };
let started = false;

const statusListeners = new Set<(status: UpdateStatus) => void>();

let stallTimer: NodeJS.Timeout | null = null;
// We auto-retry the *first* stall in a session to absorb transient network
// flakes (laptop lid, hotel wifi), then surface the error so we don't loop
// forever on a permanent failure.
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
    if (lastStatus.kind !== "downloading") return;
    if (!stallRetried) {
      stallRetried = true;
      console.warn("[zuse:updater] download stalled — retrying once");
      autoUpdater.downloadUpdate().catch((err) => {
        console.error("[zuse:updater] stall retry failed", err);
        emit({
          kind: "error",
          message: "Download stalled. Check your connection and try again.",
          retryable: true,
        });
      });
      return;
    }
    emit({
      kind: "error",
      message: "Download stalled. Check your connection and try again.",
      retryable: true,
    });
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

function attachRenderer(window: BrowserWindow): void {
  // Always re-broadcast the most recent status to a (re)attached window so a
  // dev hot-reload or future window-recreate doesn't lose state.
  const sendToRenderer = (status: UpdateStatus) => {
    if (window.isDestroyed()) return;
    window.webContents.send(UPDATE_STATUS_CHANNEL, status);
  };
  statusListeners.add(sendToRenderer);
  window.webContents.on("did-finish-load", () => sendToRenderer(lastStatus));
}

export function startAutoUpdater(window: BrowserWindow): void {
  attachRenderer(window);

  if (started) return;
  started = true;

  autoUpdater.logger = {
    info: (msg: unknown) => console.log("[zuse:updater]", msg),
    warn: (msg: unknown) => console.warn("[zuse:updater]", msg),
    error: (msg: unknown) => console.error("[zuse:updater]", msg),
    debug: () => {},
  } as unknown as typeof autoUpdater.logger;

  // Wait for the user to opt in via the banner before consuming bandwidth,
  // but if they ignore the "Restart" button we still install on next quit so
  // the update isn't stranded forever.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    clearStallTimer();
    emit({ kind: "checking" });
  });
  autoUpdater.on("update-available", (info: UpdateInfo) => {
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
    clearStallTimer();
    emit({ kind: "not-available" });
  });
  autoUpdater.on("download-progress", (p: ProgressInfo) => {
    armStallTimer();
    emit({
      kind: "downloading",
      percent: p.percent,
      bytesPerSecond: p.bytesPerSecond,
    });
  });
  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    clearStallTimer();
    emit({ kind: "ready", version: info.version });
  });
  autoUpdater.on("error", (err: Error) => {
    clearStallTimer();
    emit({ kind: "error", message: err.message, retryable: true });
  });

  ipcMain.handle(UPDATE_CHECK_CHANNEL, async () => {
    await autoUpdater.checkForUpdates().catch((err) => {
      console.error("[zuse:updater] check failed", err);
    });
  });
  ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, async () => {
    await autoUpdater.downloadUpdate().catch((err) => {
      console.error("[zuse:updater] download failed", err);
    });
  });
  ipcMain.handle(UPDATE_INSTALL_CHANNEL, () => {
    // `quitAndInstall` synchronously kicks off shutdown; the await is just
    // for symmetry with the other handlers.
    autoUpdater.quitAndInstall();
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error("[zuse:updater] check failed", err);
    });
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
  autoUpdater.checkForUpdates().catch((err) => {
    console.error("[zuse:updater] check failed", err);
  });
}

export function triggerUpdateDownload(): void {
  // Reset the stall retry budget so a manual retry gets a fresh chance.
  stallRetried = false;
  autoUpdater.downloadUpdate().catch((err) => {
    console.error("[zuse:updater] download failed", err);
  });
}

export function triggerUpdateInstall(): void {
  autoUpdater.quitAndInstall();
}

/**
 * Dev-only IPC bridge for previewing the update banner without cutting a real
 * release. `window.__zuseUpdateDemo.set(status)` in the renderer round-trips
 * through `zuse:update-demo-set`, which re-broadcasts on the same channel
 * the real updater uses — so the banner sees indistinguishable payloads.
 *
 * Call from `main.ts` only when `isDevelopment`. No-op in packaged builds.
 */
export function registerUpdaterDemo(window: BrowserWindow): void {
  // Plumb the renderer so demo-pushed statuses reach the banner.
  attachRenderer(window);
  ipcMain.handle("zuse:update-demo-set", (_event, status: UpdateStatus) => {
    if (window.isDestroyed()) return;
    // Push through `emit` so the menu listener and any other subscribers
    // see demo events the same way they'd see real ones.
    emit(status);
  });
}
