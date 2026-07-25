export const errorMessage = (cause: unknown, fallback: string): string => {
	if (
		cause !== null &&
		typeof cause === "object" &&
		"reason" in cause &&
		typeof cause.reason === "string" &&
		cause.reason.trim() !== ""
	) {
		return cause.reason;
	}
	if (cause instanceof Error && cause.message.trim() !== "")
		return cause.message;
	return fallback;
};
