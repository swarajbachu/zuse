/**
 * Shared primitives for the browser-facing pages the product serves from its
 * loopback listeners and the relay worker (sign-in, integration connect,
 * checkout complete). The pages themselves stay next to the code that serves
 * them — the runtimes have no common view layer — but sanitization and response
 * hardening are one behavior and live here so a fix lands everywhere at once.
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
	'"': "&quot;",
	"&": "&amp;",
	"'": "&#39;",
	"<": "&lt;",
	">": "&gt;",
};

/** Escape a value for interpolation into HTML text or a quoted attribute. */
export const escapeHtml = (value: string): string =>
	value.replaceAll(/["&'<>]/gu, (character) => HTML_ESCAPES[character] ?? "");

/**
 * Trim, clamp, and escape untrusted text (provider error descriptions, product
 * names). Returns `null` when nothing is left, so callers can fall back to
 * their own copy instead of rendering an empty slot.
 */
export const clampedText = (
	value: string | undefined,
	maxLength: number,
): string | null => {
	const trimmed = value?.trim() ?? "";
	if (trimmed.length === 0) return null;
	return escapeHtml(
		trimmed.length > maxLength
			? `${trimmed.slice(0, maxLength - 1)}…`
			: trimmed,
	);
};

/**
 * Response headers for every browser-facing page. These URLs carry
 * authorization codes and checkout ids, so nothing is cached, referred, or
 * framed, and the pages are built to need no resource beyond inline styles.
 */
export const BROWSER_PAGE_HEADERS: Readonly<Record<string, string>> = {
	"cache-control": "no-store",
	"content-security-policy":
		"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
	"content-type": "text/html; charset=utf-8",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
};
