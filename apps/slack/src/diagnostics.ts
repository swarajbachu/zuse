import { SlackApiError, SlackRateLimitError } from "./slack.ts";
import { diagnosticCode, ZuseApiError } from "./zuse.ts";

/** Explicit fields only: no Error.message/stack, request bodies, headers, URLs or credentials. */
export const errorDiagnostics = (error: unknown) => {
	if (error instanceof ZuseApiError)
		return {
			errorType: "ZuseApiError",
			status: error.status,
			code: error.code ?? "unclassified_api_error",
			operation: error.operation,
			retryable: error.retryable,
		};
	if (error instanceof SlackApiError)
		return {
			errorType: "SlackApiError",
			status: error.status,
			code: diagnosticCode(error.code) ?? "unclassified_slack_error",
			retryable: error.retryable,
		};
	if (error instanceof SlackRateLimitError)
		return {
			errorType: "SlackRateLimitError",
			retryAfterSeconds: error.retryAfterSeconds,
			retryable: true,
		};
	return {
		errorType:
			error instanceof Error &&
			["AbortError", "TimeoutError"].includes(error.name)
				? error.name
				: "UnexpectedError",
	};
};
