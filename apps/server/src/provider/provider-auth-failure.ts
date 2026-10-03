import type { MessageContent } from "@zuse/contracts";

/**
 * Server-side source of truth for provider failures that are positively
 * recoverable by refreshing authentication before another submission.
 */
export const isProviderAuthenticationRequired = (reason: string): boolean =>
	/\b(?:authentication required|authorizationrequired|invalid authentication credentials|invalid api key)\b|please (?:run \/login|log ?in)|(?:claude|codex|cursor|grok)-auth-(?:reconnect-required|reconnecting)|oauth (?:token|session) (?:has )?expired|failed to authenticate|authentication_error|refresh token (?:was already used|has expired|was revoked)|\b401 unauthorized\b/iu.test(
		reason,
	);

/** A persisted transcript error that sign-in recovers; trusts the driver's typed kind. */
export const isProviderAuthenticationError = (
	content: MessageContent | undefined,
): boolean =>
	content?._tag === "error" &&
	(content.kind === "auth" ||
		isProviderAuthenticationRequired(content.message));
