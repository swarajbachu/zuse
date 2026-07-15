const PREVIEWABLE_EXTENSIONS = new Set([
	".htm",
	".html",
	".markdown",
	".md",
	".mdown",
	".mkd",
]);

const MARKDOWN_EXTENSIONS = new Set([".markdown", ".md", ".mdown", ".mkd"]);

const extensionOf = (name: string): string => {
	const lower = name.toLowerCase();
	const dot = lower.lastIndexOf(".");
	return dot === -1 ? "" : lower.slice(dot);
};

export const isPreviewableFileName = (name: string): boolean => {
	return PREVIEWABLE_EXTENSIONS.has(extensionOf(name));
};

export const defaultFileViewForName = (name: string): "edit" | "preview" =>
	MARKDOWN_EXTENSIONS.has(extensionOf(name)) ? "preview" : "edit";

/**
 * Resolve a relative image in a local Markdown preview against the directory
 * containing the Markdown file. Keep all other URLs on react-markdown's
 * normal sanitising path, and do not let Markdown traverse above its own
 * directory when resolving an image.
 */
export const resolveMarkdownPreviewUrl = (
	value: string,
	property: string,
	tagName: string,
	baseHref: string | undefined,
): string | null => {
	if (baseHref === undefined || property !== "src" || tagName !== "img") {
		return null;
	}
	try {
		const base = new URL(baseHref);
		if (base.protocol !== "file:") return null;
		const resolved = new URL(value, base);
		if (resolved.protocol !== "file:") return null;
		if (!resolved.pathname.startsWith(base.pathname)) return null;
		if (
			!/\/\.context\/linear\/[^/]+\/assets\/[^/]+\/[^/]+$/u.test(
				resolved.pathname,
			)
		) {
			return null;
		}
		return `zuse://linear-context${resolved.pathname}`;
	} catch {
		return null;
	}
};
