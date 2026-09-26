import type { CloudSyncStatus } from "./bridge.ts";

/** Shared by the SSH menu and local terminal; idle is never called syncing. */
export const cloudSyncPresentation = (status: CloudSyncStatus | null) => {
	const state = status?.state ?? "idle";
	const progress = status?.progress;
	const active = state === "pending" || state === "syncing";
	const label =
		state === "in-sync"
			? "Up to date"
			: state === "error"
				? "Sync interrupted"
				: state === "pending"
					? "Connecting to workspace…"
					: state === "syncing"
						? progress?.phase === "applying"
							? "Applying files…"
							: progress?.phase === "downloading"
								? `Receiving ${progress.files.toLocaleString()} / ${progress.total.toLocaleString()} files`
								: "Scanning files…"
						: "Sync paused";
	const detail =
		state === "error"
			? (status?.error ?? "Retrying automatically.")
			: progress?.phase === "downloading"
				? `${(progress.bytes / 1048576).toFixed(1)} MB received · Changes appear after the batch completes`
				: null;
	const dotClass =
		state === "in-sync"
			? "bg-[var(--accent-green)]"
			: state === "error"
				? "bg-[var(--accent-red)]"
				: active
					? "animate-pulse bg-[var(--accent-yellow,#eab308)]"
					: "bg-muted-foreground/50";
	return { label, detail, dotClass };
};
