import { formatRelativeTime as formatLocaleRelativeTime } from "@zuse/i18n";
import { useEffect, useState } from "react";
import { startVisibleInterval } from "./visible-interval.ts";

/**
 * Re-renders the caller every `intervalMs` to keep "X seconds ago" strings
 * fresh without anyone having to manage a `setInterval`.
 */
export function useRelativeTimeTick(intervalMs: number = 30_000): number {
	const [, setTick] = useState(0);
	useEffect(
		() => startVisibleInterval(() => setTick((t) => t + 1), intervalMs),
		[intervalMs],
	);
	return Date.now();
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Format an absolute date as a short "X ago" string. Tuned for the
 * "Checked just now" line — granular enough to feel live, coarse enough
 * not to flicker.
 */
export function formatRelativeTime(
	date: Date | string | number | null | undefined,
	now: number = Date.now(),
): string | null {
	if (date === null || date === undefined) return null;
	const ts =
		typeof date === "number"
			? date
			: typeof date === "string"
				? new Date(date).getTime()
				: date.getTime();
	if (Number.isNaN(ts)) return null;
	const diff = Math.max(0, now - ts);
	if (diff < 10 * SECOND) return "just now";
	if (diff < MINUTE) return `${Math.floor(diff / SECOND)}s ago`;
	if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
	if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
	return `${Math.floor(diff / DAY)}d ago`;
}

/** Localized "5 minutes ago" for a past timestamp, in the coarsest fitting unit. */
export function formatTimeAgo(
	timestamp: number,
	now: number = Date.now(),
): string {
	const diff = Math.max(0, now - timestamp);
	if (diff < MINUTE) return formatLocaleRelativeTime(0, "second");
	if (diff < HOUR)
		return formatLocaleRelativeTime(-Math.floor(diff / MINUTE), "minute");
	if (diff < DAY)
		return formatLocaleRelativeTime(-Math.floor(diff / HOUR), "hour");
	return formatLocaleRelativeTime(-Math.floor(diff / DAY), "day");
}
