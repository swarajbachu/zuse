const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;
const MAX_AUTOMATIC_RETRIES = 2;

export const catalogRetryDelayMs = (attempt: number): number =>
	RETRY_DELAYS_MS[Math.min(Math.max(attempt, 0), RETRY_DELAYS_MS.length - 1)] ??
	60_000;

type Schedule = (delayMs: number, run: () => void) => () => void;

/**
 * Small catalog-level recovery coordinator for failures that happen before an
 * RPC client exists (for example, opening an SSH tunnel or resolving a
 * Tailnet endpoint). Transport reconnects remain owned by the RPC supervisor.
 */
export const createCatalogRetryController = (scheduleTimer: Schedule) => {
	const attempts = new Map<string, number>();
	const timers = new Map<string, () => void>();
	const stopped = new Set<string>();

	const cancelTimer = (key: string): void => {
		timers.get(key)?.();
		timers.delete(key);
	};

	return {
		schedule(key: string, retry: () => void): void {
			if (stopped.has(key) || timers.has(key)) return;
			const attempt = attempts.get(key) ?? 0;
			if (attempt >= MAX_AUTOMATIC_RETRIES) {
				stopped.add(key);
				return;
			}
			attempts.set(key, attempt + 1);
			const cancel = scheduleTimer(catalogRetryDelayMs(attempt), () => {
				timers.delete(key);
				retry();
			});
			timers.set(key, cancel);
		},
		succeeded(key: string): void {
			cancelTimer(key);
			attempts.delete(key);
			stopped.delete(key);
		},
		prepareManualRetry(key: string): void {
			cancelTimer(key);
			attempts.delete(key);
			stopped.delete(key);
		},
		stop(key: string): void {
			cancelTimer(key);
			attempts.delete(key);
			stopped.add(key);
		},
	};
};
