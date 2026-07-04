import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert01Icon,
  CheckmarkCircle02Icon,
  CircleArrowUp01Icon,
} from "@hugeicons-pro/core-bulk-rounded";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import type { UpdateStatus } from "@zuse/wire";

import { Button } from "~/components/ui/button";
import { ShimmerText } from "~/components/ui/shimmer-text";
import {
  Progress,
  ProgressIndicator,
  ProgressTrack,
} from "~/components/ui/progress";

/**
 * Bottom-right toast for the electron-updater lifecycle. Subscribes to the
 * preload bridge's `updates.onStatus` channel.
 *
 * Lifecycle:
 *  - `available` → shows "Update now / Install on quit / Later" — nothing
 *     downloads until the user picks.
 *  - `downloading` → progress bar; "Update now" auto-installs when ready,
 *     "Install on quit" silently completes and stays out of the way.
 *  - `ready` → if user picked "Update now", we call installNow immediately;
 *     otherwise the toast hides (electron-updater installs on next quit
 *     because `autoInstallOnAppQuit = true` in the main process).
 *
 * Idle / checking / not-available / error are no-ops.
 */
export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });
  const [dismissed, setDismissed] = useState(false);
  // Tracks which option the user picked so we know what to do when the
  // download completes. Ref because we don't want to trigger a re-render
  // when it changes — only the IPC-driven `status` does.
  const installModeRef = useRef<"now" | "quit" | null>(null);

  useEffect(() => {
    const updates = window.zuse?.updates;
    if (!updates) return;
    return updates.onStatus(setStatus);
  }, []);

  // Re-surface a fresh "available" even if the user dismissed the previous one.
  // Also re-show on `error` so a silent stall or failed download isn't
  // invisible — the user needs to see it to retry.
  useEffect(() => {
    if (status.kind === "available" || status.kind === "error") {
      installModeRef.current = null;
      setDismissed(false);
    }
  }, [status.kind]);

  // Auto-install on ready when the user explicitly chose "Update now".
  useEffect(() => {
    if (status.kind === "ready" && installModeRef.current === "now") {
      void window.zuse?.updates?.installNow();
    }
  }, [status.kind]);

  if (
    dismissed ||
    status.kind === "idle" ||
    status.kind === "checking" ||
    status.kind === "not-available"
  ) {
    return null;
  }

  // "Install on quit" mode disappears entirely once download finishes —
  // electron-updater's autoInstallOnAppQuit handles the rest silently.
  if (status.kind === "ready" && installModeRef.current === "quit") {
    return null;
  }

  const onUpdateNow = () => {
    installModeRef.current = "now";
    void window.zuse?.updates?.download();
  };
  const onUpdateOnQuit = () => {
    installModeRef.current = "quit";
    void window.zuse?.updates?.download();
  };
  const onLater = () => {
    setDismissed(true);
  };
  const onRestartNow = () => {
    void window.zuse?.updates?.installNow();
  };
  const onRetry = () => {
    installModeRef.current = null;
    void window.zuse?.updates?.check();
  };

  // Portal to document.body so the toast escapes any ancestor that creates a
  // containing block — `<main>` uses `backdrop-blur-3xl`, and any
  // backdrop-filter (or transform/filter/perspective) traps `position: fixed`
  // to that ancestor instead of the viewport. Without the portal the toast
  // sticks to the bottom-right of the chat pane, not the window.
  return createPortal(
    <div
      role="status"
      className="fixed right-4 bottom-4 z-50 flex w-[320px] flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-lg"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
          {status.kind === "ready" ? (
            <HugeiconsIcon icon={CheckmarkCircle02Icon} className="size-4" />
          ) : status.kind === "error" ? (
            <HugeiconsIcon icon={Alert01Icon} className="size-4" />
          ) : (
            <HugeiconsIcon icon={CircleArrowUp01Icon} className="size-4" />
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[13px] font-medium text-foreground">
            {status.kind === "available" && "Update available"}
            {status.kind === "downloading" && (
              <ShimmerText>Downloading update…</ShimmerText>
            )}
            {status.kind === "ready" && "Update ready"}
            {status.kind === "error" && "Update failed"}
          </span>
          <span className="text-[12px] leading-snug text-muted-foreground">
            {status.kind === "available" &&
              `Zuse Alpha ${status.version} is ready to install.`}
            {status.kind === "downloading" &&
              `${Math.round(status.percent)}%${
                status.bytesPerSecond > 0
                  ? ` · ${formatRate(status.bytesPerSecond)}`
                  : ""
              }`}
            {status.kind === "ready" &&
              `Restart to finish installing Zuse Alpha ${status.version}.`}
            {status.kind === "error" && status.message}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Dismiss update toast"
        >
          <X className="size-3.5" strokeWidth={1.8} />
        </button>
      </div>

      {status.kind === "downloading" && (
        <Progress value={status.percent}>
          <ProgressTrack>
            <ProgressIndicator />
          </ProgressTrack>
        </Progress>
      )}

      {status.kind === "available" && (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Button
            size="xs"
            variant="ghost"
            onClick={onLater}
            className="rounded-full text-[11px]"
          >
            Later
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={onUpdateOnQuit}
            className="rounded-full text-[11px]"
          >
            Install on quit
          </Button>
          <Button
            size="xs"
            onClick={onUpdateNow}
            className="rounded-full text-[11px]"
          >
            Update now
          </Button>
        </div>
      )}

      {status.kind === "ready" && (
        <div className="flex items-center justify-end gap-1.5">
          <Button
            size="xs"
            variant="ghost"
            onClick={onLater}
            className="rounded-full text-[11px]"
          >
            Later
          </Button>
          <Button
            size="xs"
            onClick={onRestartNow}
            className="rounded-full text-[11px]"
          >
            Restart now
          </Button>
        </div>
      )}

      {status.kind === "error" && (
        <div className="flex items-center justify-end gap-1.5">
          <Button
            size="xs"
            variant="ghost"
            onClick={onLater}
            className="rounded-full text-[11px]"
          >
            Dismiss
          </Button>
          {status.retryable !== false && (
            <Button
              size="xs"
              onClick={onRetry}
              className="rounded-full text-[11px]"
            >
              Try again
            </Button>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}

function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1_000_000) {
    return `${(bytesPerSecond / 1_000_000).toFixed(1)} MB/s`;
  }
  if (bytesPerSecond >= 1_000) {
    return `${(bytesPerSecond / 1_000).toFixed(0)} KB/s`;
  }
  return `${Math.round(bytesPerSecond)} B/s`;
}
