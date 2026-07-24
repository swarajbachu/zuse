const TRANSIENT_HTTP_STATUS =
	/\b(?:408|425|429|500|502|503|504)\b|gateway time-out|service unavailable/i;
const TRANSIENT_NETWORK_ERROR =
	/\b(?:ECONNRESET|ECONNREFUSED|ENETDOWN|ENETUNREACH|ETIMEDOUT|EAI_AGAIN)\b/i;

export const AUTOMATIC_UPDATE_RETRY_DELAYS_MS = [
	15_000,
	60_000,
	5 * 60_000,
] as const;

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

export const isTransientUpdateCheckError = (error: unknown): boolean => {
	const message = errorMessage(error);
	return (
		TRANSIENT_HTTP_STATUS.test(message) || TRANSIENT_NETWORK_ERROR.test(message)
	);
};

export const automaticUpdateRetryDelay = (
	failedAttempt: number,
): number | null => AUTOMATIC_UPDATE_RETRY_DELAYS_MS[failedAttempt] ?? null;

export const updateCheckErrorMessage = (error: unknown): string =>
	isTransientUpdateCheckError(error)
		? "GitHub is temporarily unavailable. Try again in a moment."
		: "Couldn’t check for updates. Try again.";

export const updateDownloadErrorMessage = (error: unknown): string =>
	isTransientUpdateCheckError(error)
		? "The update service is temporarily unavailable. Try again in a moment."
		: "Couldn’t download the update. Check your connection and try again.";
