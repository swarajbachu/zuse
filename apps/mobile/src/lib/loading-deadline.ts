export const HOME_LOADING_TIMEOUT_MS = 30_000;

/** A single deadline, independent of individual reconnect attempts. */
export const startLoadingDeadline = (onTimeout: () => void): (() => void) => {
	const timer = setTimeout(onTimeout, HOME_LOADING_TIMEOUT_MS);
	return () => clearTimeout(timer);
};
