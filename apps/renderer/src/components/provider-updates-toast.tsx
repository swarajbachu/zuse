import { HugeiconsIcon } from "@hugeicons/react";
import { CircleArrowUp01Icon } from "@hugeicons-pro/core-stroke-rounded";
import { X } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "~/components/ui/button";
import { overlaySurface } from "~/components/ui/overlay-surface";
import { readStorageWithLegacy } from "~/lib/storage-keys";
import { cn } from "~/lib/utils";
import { useProvidersStore } from "~/store/providers";
import { useUiStore } from "~/store/ui";

// Persist dismissed update sets so we don't re-nag every launch. The key
// encodes the exact (provider, latestVersion) pairs, so dismissing "Codex
// v1.2.0 + Claude v1.0.5" stays hidden — but a newer release changes the key
// and the toast returns.
const STORAGE_KEY = "zuse.dismissedProviderUpdates";
const LEGACY_STORAGE_KEYS = ["memoize.dismissedProviderUpdates"] as const;

function loadDismissed(): Set<string> {
	try {
		const raw = readStorageWithLegacy(
			window.localStorage,
			STORAGE_KEY,
			LEGACY_STORAGE_KEYS,
		);
		if (raw === null) return new Set();
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed)
			? new Set(parsed.filter((x): x is string => typeof x === "string"))
			: new Set();
	} catch {
		return new Set();
	}
}

function persistDismissed(keys: ReadonlySet<string>): void {
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]));
	} catch {
		// localStorage can be unavailable (private mode / strict CSP). The toast
		// simply re-appears next launch — non-fatal.
	}
}

/**
 * Bottom-right toast announcing that one or more provider CLIs have a newer
 * published release. Check-and-notify only — it routes the user to provider
 * settings (where the per-provider popover shows the update command); it never
 * runs an update itself.
 *
 * Styled to match `UpdateBanner` (the app-update toast); offset upward so the
 * two don't overlap when both are visible.
 */
export function ProviderUpdatesToast() {
	const availability = useProvidersStore((s) => s.availability);
	const setView = useUiStore((s) => s.setView);
	const setSettingsSection = useUiStore((s) => s.setSettingsSection);
	const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() =>
		loadDismissed(),
	);

	const candidates = availability.filter(
		(a) => a.latestVersionStatus === "behind",
	);
	const notificationKey =
		candidates.length === 0
			? ""
			: candidates
					.map((a) => `${a.providerId}:${a.latestVersion ?? "?"}`)
					.sort()
					.join(",");

	if (notificationKey === "" || dismissed.has(notificationKey)) {
		return null;
	}

	const recordDismissed = () => {
		const next = new Set(dismissed);
		next.add(notificationKey);
		persistDismissed(next);
		setDismissed(next);
	};

	const onReview = () => {
		setView("settings");
		setSettingsSection({ kind: "providers" });
		recordDismissed();
	};

	const single = candidates.length === 1 ? candidates[0] : undefined;
	const title =
		single !== undefined
			? `Update available: ${single.displayName}${
					single.latestVersion !== undefined ? ` v${single.latestVersion}` : ""
				}`
			: `Updates available: ${candidates.length} providers`;

	const detail =
		single !== undefined
			? `A newer release of ${single.displayName} is published.`
			: candidates
					.map(
						(a) =>
							`${a.displayName}${
								a.latestVersion !== undefined ? ` v${a.latestVersion}` : ""
							}`,
					)
					.join(", ");

	// Portal to body so the toast escapes any ancestor with a backdrop-filter /
	// transform that would trap `position: fixed` (same reason as UpdateBanner).
	return createPortal(
		<div
			role="status"
			className={cn(
				"fixed right-4 bottom-24 z-50 flex w-[320px] flex-col gap-3 p-4",
				overlaySurface,
			)}
		>
			<div className="flex items-start gap-3">
				<span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
					<HugeiconsIcon icon={CircleArrowUp01Icon} className="size-4" />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="text-[13px] font-medium text-foreground">
						{title}
					</span>
					<span className="text-[12px] leading-snug text-muted-foreground">
						{detail}
					</span>
				</div>
				<button
					type="button"
					onClick={recordDismissed}
					className="text-muted-foreground hover:text-foreground"
					aria-label="Dismiss provider update toast"
				>
					<X className="size-3.5" strokeWidth={1.8} />
				</button>
			</div>

			<div className="flex items-center justify-end gap-1.5">
				<Button
					size="xs"
					variant="ghost"
					onClick={recordDismissed}
					className="rounded-full text-[11px]"
				>
					Dismiss
				</Button>
				<Button
					size="xs"
					onClick={onReview}
					className="rounded-full text-[11px]"
				>
					Review in settings
				</Button>
			</div>
		</div>,
		document.body,
	);
}
