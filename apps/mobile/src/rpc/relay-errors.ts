export const normalizeRelayError = (
	status: number,
	text: string,
	prefix: string,
): string => {
	const fallback = `${prefix}_${status}`;
	if (text.trim().length === 0) return fallback;
	try {
		const body = JSON.parse(text) as { readonly error?: unknown };
		if (typeof body.error === "string" && body.error.length > 0) {
			return `${fallback}:${body.error}`;
		}
	} catch {
		// Fall through to text cleanup.
	}
	if (isTransientRelayStatus(status)) {
		return fallback;
	}
	if (looksLikeHtml(text)) {
		return fallback;
	}
	const compact = text
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120);
	return compact.length > 0 ? `${fallback}:${compact}` : fallback;
};

const isTransientRelayStatus = (status: number): boolean =>
	status === 429 || status >= 500;

const looksLikeHtml = (text: string): boolean => {
	const value = text.trim().toLowerCase();
	return (
		value.startsWith("<!doctype html") ||
		value.startsWith("<html") ||
		value.includes("<body") ||
		value.includes("<script") ||
		value.includes("cloudflare")
	);
};
