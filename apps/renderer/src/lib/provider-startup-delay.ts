import { useEffect, useState } from "react";

export const PROVIDER_SLOW_START_MS = 12_000;

export const providerStartupLabel = ({
	providerLabel,
	failed,
	delayed,
}: {
	readonly providerLabel: string;
	readonly failed: boolean;
	readonly delayed: boolean;
}): string => {
	if (failed) return `${providerLabel} failed to start`;
	if (delayed) return `${providerLabel} is taking longer than usual to start…`;
	return `Starting ${providerLabel}`;
};

/**
 * Turns a continuing provider boot into a quiet warning after the expected
 * startup window. The attempt key resets the clock when the user retries or
 * switches sessions, while a completed/failed attempt clears it immediately.
 */
export const useProviderStartupDelay = (
	active: boolean,
	attemptKey: string,
	delayMs = PROVIDER_SLOW_START_MS,
): boolean => {
	const [delayed, setDelayed] = useState(false);

	useEffect(() => {
		setDelayed(false);
		if (!active) return;
		const timer = window.setTimeout(() => setDelayed(true), delayMs);
		return () => window.clearTimeout(timer);
	}, [active, attemptKey, delayMs]);

	return delayed;
};
