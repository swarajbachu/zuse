const IMAGE_EXTENSIONS = new Set([
	"avif",
	"gif",
	"jpeg",
	"jpg",
	"png",
	"svg",
	"webp",
]);

const QUICK_LOOK_EXTENSIONS = new Set([
	"doc",
	"docx",
	"key",
	"numbers",
	"pages",
	"pdf",
	"ppt",
	"pptx",
	"rtf",
	"txt",
	"xls",
	"xlsx",
]);

const extensionOf = (name: string): string => {
	const basename = name.split(/[\\/]/u).pop() ?? "";
	const dot = basename.lastIndexOf(".");
	return dot < 0 ? "" : basename.slice(dot + 1).toLowerCase();
};

export type MediaKind = "image" | "document" | "other";

export const classifyMedia = (
	name: string,
	mimeType?: string | null,
): MediaKind => {
	const mime = mimeType?.toLowerCase() ?? "";
	if (mime.startsWith("image/") || IMAGE_EXTENSIONS.has(extensionOf(name))) {
		return "image";
	}
	if (
		mime === "application/pdf" ||
		mime.startsWith("text/") ||
		QUICK_LOOK_EXTENSIONS.has(extensionOf(name))
	) {
		return "document";
	}
	return "other";
};

export const isRemoteMarkdownImage = (url: string): boolean =>
	/^https?:\/\//iu.test(url.trim());

export const mediaMimeType = (name: string): string => {
	switch (extensionOf(name)) {
		case "avif":
			return "image/avif";
		case "gif":
			return "image/gif";
		case "jpeg":
		case "jpg":
			return "image/jpeg";
		case "png":
			return "image/png";
		case "svg":
			return "image/svg+xml";
		case "webp":
			return "image/webp";
		case "pdf":
			return "application/pdf";
		default:
			return "application/octet-stream";
	}
};

/**
 * Conservative SVG sanitizer for local previews: removes executable/embed
 * nodes, event handlers, and non-fragment links before native image decoding.
 */
export const sanitizeSvg = (source: string): string =>
	source
		.replace(
			/<(?:script|foreignObject|iframe|object|embed)\b[\s\S]*?<\/(?:script|foreignObject|iframe|object|embed)\s*>/giu,
			"",
		)
		.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*')/giu, "")
		.replace(/\s(?:href|xlink:href)\s*=\s*(["'])(?!#)[\s\S]*?\1/giu, "");
