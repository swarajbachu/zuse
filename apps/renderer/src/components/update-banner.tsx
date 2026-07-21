import { HugeiconsIcon } from "@hugeicons/react";
import {
	Alert01Icon,
	CircleArrowUp01Icon,
} from "@hugeicons-pro/core-stroke-rounded";
import type { UpdateStatus } from "@zuse/contracts";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "~/components/ui/button";
import { overlaySurface } from "~/components/ui/overlay-surface";
import { cn } from "~/lib/utils";
import { useMessagesStore } from "~/store/messages.ts";

/**
 * Bottom-right toast for the electron-updater lifecycle. Subscribes to the
 * preload bridge's `updates.onStatus` channel.
 *
 * Downloads happen automatically in the background (`autoDownload = true` in
 * the main process), so the toast stays silent through `checking` /
 * `available` / `downloading` and only appears once the update is fully
 * downloaded (`ready`) — or on `error`.
 *
 * On `ready` the user picks one of:
 *  - **Restart now** — installs + relaunches immediately. If agents are still
 *    running we confirm first ("N agents are running — restart anyway?").
 *  - **Restart later** — dismiss; electron-updater installs on next quit
 *    (`autoInstallOnAppQuit = true`).
 *  - **Restart when idle** — installs automatically once no agents are running.
 */
export function UpdateBanner() {
	const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });
	const [dismissed, setDismissed] = useState(false);
	// Whether the in-toast "restart anyway?" confirmation is showing (set when
	// the user clicks "Restart now" while agents are running).
	const [confirming, setConfirming] = useState(false);
	// When true, we install automatically the moment the running-agent count
	// reaches zero. Survives a dismiss so "restart when idle" still fires after
	// the user tucks the toast away.
	const [installWhenIdle, setInstallWhenIdle] = useState(false);

	// Global count of sessions with an in-flight turn. Primitive selector, so
	// this only re-renders when the number actually changes.
	const runningCount = useMessagesStore((s) => {
		let count = 0;
		for (const running of Object.values(s.runningBySession)) {
			if (running) count += 1;
		}
		return count;
	});

	useEffect(() => {
		const updates = window.zuse?.updates;
		if (!updates) return;
		return updates.onStatus(setStatus);
	}, []);

	// Re-surface a fresh `ready`/`error` even if a previous toast was dismissed,
	// and reset the transient confirm state. `installWhenIdle` is intentionally
	// NOT reset here so it persists across a dismiss.
	useEffect(() => {
		if (status.kind === "ready" || status.kind === "error") {
			setConfirming(false);
			setDismissed(false);
		}
	}, [status.kind]);

	// Install automatically once agents finish, if the user chose "when idle".
	useEffect(() => {
		if (installWhenIdle && status.kind === "ready" && runningCount === 0) {
			void window.zuse?.updates?.installNow();
		}
	}, [installWhenIdle, status.kind, runningCount]);

	if (dismissed || (status.kind !== "ready" && status.kind !== "error")) {
		return null;
	}

	const onRestartNow = () => {
		if (runningCount > 0) {
			setConfirming(true);
			return;
		}
		void window.zuse?.updates?.installNow();
	};
	const onConfirmRestart = () => {
		void window.zuse?.updates?.installNow();
	};
	const onCancelConfirm = () => {
		setConfirming(false);
	};
	const onRestartWhenIdle = () => {
		if (runningCount === 0) {
			void window.zuse?.updates?.installNow();
			return;
		}
		setInstallWhenIdle(true);
		setDismissed(true);
	};
	const onLater = () => {
		setDismissed(true);
	};
	const onRetry = () => {
		void window.zuse?.updates?.check();
	};

	const isError = status.kind === "error";

	// Portal to document.body so the toast escapes any ancestor that creates a
	// containing block — `<main>` uses `backdrop-blur-3xl`, and any
	// backdrop-filter (or transform/filter/perspective) traps `position: fixed`
	// to that ancestor instead of the viewport. Without the portal the toast
	// sticks to the bottom-right of the chat pane, not the window.
	return createPortal(
		<div
			role="status"
			className={cn(
				"fixed right-4 bottom-4 z-50 flex w-[320px] flex-col gap-3 p-4",
				overlaySurface,
			)}
		>
			<div className="flex items-start gap-3">
				<span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
					<HugeiconsIcon
						icon={isError ? Alert01Icon : CircleArrowUp01Icon}
						className="size-4"
					/>
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="text-[13px] font-medium text-foreground">
						{isError
							? "Update failed"
							: confirming
								? "Agents are running"
								: "Update available"}
					</span>
					<span className="text-[12px] leading-snug text-muted-foreground">
						{isError && status.message}
						{status.kind === "ready" &&
							!confirming &&
							`Zuse Alpha ${status.version} is ready. Restart to finish installing.`}
						{status.kind === "ready" &&
							confirming &&
							`${
								runningCount === 1 ? "1 agent is" : `${runningCount} agents are`
							} running and will stop mid-turn. Restart anyway?`}
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

			{status.kind === "ready" && !confirming && (
				<div className="flex flex-wrap items-center justify-end gap-1.5">
					<Button
						size="xs"
						variant="ghost"
						onClick={onLater}
						className="rounded-full text-[11px]"
					>
						Restart later
					</Button>
					<Button
						size="xs"
						variant="ghost"
						onClick={onRestartWhenIdle}
						className="rounded-full text-[11px]"
					>
						Restart when idle
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

			{status.kind === "ready" && confirming && (
				<div className="flex items-center justify-end gap-1.5">
					<Button
						size="xs"
						variant="ghost"
						onClick={onCancelConfirm}
						className="rounded-full text-[11px]"
					>
						Cancel
					</Button>
					<Button
						size="xs"
						onClick={onConfirmRestart}
						className="rounded-full text-[11px]"
					>
						Restart anyway
					</Button>
				</div>
			)}

			{isError && (
				<div className="flex items-center justify-end gap-1.5">
					<Button
						size="xs"
						variant="ghost"
						onClick={() => setDismissed(true)}
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
