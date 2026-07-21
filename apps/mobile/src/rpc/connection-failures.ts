import { ConnectionFailed } from "./errors";

/** True only for cancellation produced when an owned Effect scope is replaced. */
export const isIntentionalConnectionInterruption = (
	cause: unknown,
): boolean => {
	const message = cause instanceof Error ? cause.message : String(cause);
	return (
		message.trim().toLowerCase() === "all fibers interrupted without error"
	);
};

/** True only when retrying the shared transport can make the operation succeed. */
export const isRetryableClientError = (cause: unknown): boolean =>
	(cause instanceof ConnectionFailed && cause.message !== "offline") ||
	(typeof cause === "object" &&
		cause !== null &&
		"_tag" in cause &&
		cause._tag === "RpcClientError");
