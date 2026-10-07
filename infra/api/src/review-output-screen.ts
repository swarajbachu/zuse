/** Conservative publication guard. Not a claim of comprehensive secret detection. */
export function screenReviewOutput(
	text: string,
	knownSecrets: readonly string[] = [],
): boolean {
	if (
		text.length > 300_000 ||
		Array.from(text).some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 && code !== 9 && code !== 10 && code !== 13;
		})
	)
		return false;
	if (
		knownSecrets.some((secret) => secret.length >= 8 && text.includes(secret))
	)
		return false;
	return ![
		/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/u,
		/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/u,
		/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/u,
		/(?:authorization\s*[:=]\s*["']?(?:bearer|basic)\s+[A-Za-z0-9+/_=.-]{12,})/iu,
		/(?:access_token|refresh_token|client_secret|api_key|password)\s*["']?\s*[:=]\s*["'][^"'\s]{12,}["']/iu,
	].some((pattern) => pattern.test(text));
}
