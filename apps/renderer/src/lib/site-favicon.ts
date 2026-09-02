const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

export const hostnameFromLink = (value: string): string | null => {
	try {
		const url = new URL(value);
		return HTTP_PROTOCOLS.has(url.protocol) ? url.hostname.toLowerCase() : null;
	} catch {
		return null;
	}
};

/**
 * Google serves a small, cacheable icon without exposing the renderer to an
 * arbitrary site's HTML. The visible component still owns a local fallback.
 */
export const faviconUrlForLink = (value: string): string | null => {
	const hostname = hostnameFromLink(value);
	if (hostname === null) return null;
	const encoded = encodeURIComponent(hostname);
	const desktop = globalThis.window?.zuse ?? globalThis.window?.memoize;
	return desktop === undefined
		? `/assets/site-favicon/${encoded}`
		: `zuse://site-favicon/${encoded}`;
};
