export interface CodeHighlightResult {
	readonly key: string;
	readonly html: string;
}

export function codeHighlightKey({
	code,
	lang,
}: {
	readonly code: string;
	readonly lang: string;
}): string {
	return `${lang.length}:${lang}${code.length}:${code}`;
}

/** Prevent an async result for an earlier streaming chunk from being painted. */
export function selectCurrentHighlight(
	result: CodeHighlightResult | null,
	currentKey: string | null,
): string | null {
	return result !== null && result.key === currentKey ? result.html : null;
}

/**
 * Shiki separates block-level `.line` spans with literal newlines. Preserved
 * whitespace turns those separators into anonymous blank rows in Chromium.
 */
export function normalizeHighlightedCodeHtml(html: string): string {
	return html
		.replace(/\n(?=<span class="line"(?:\s|>))/g, "")
		.replace(
			/^<pre\b([^>]*)\s+tabindex=(?:"[^"]*"|'[^']*')([^>]*)>/i,
			"<pre$1$2>",
		);
}
