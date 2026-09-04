/**
 * Server-side source of truth for provider failures that are positively
 * recoverable by refreshing authentication before another submission.
 */
export const isProviderAuthenticationRequired = (reason: string): boolean =>
	/\b(?:authentication required|authorizationrequired|invalid authentication credentials|invalid api key)\b|please (?:run \/login|log ?in)|codex-auth-(?:reconnect-required|reconnecting)|refresh token (?:was already used|has expired|was revoked)|\b401 unauthorized\b/iu.test(
		reason,
	);
