// Material Icon Theme path → icon-name resolution (mobile copy). Mirrors the
// desktop resolver in apps/renderer/src/lib/icons/material-icons.ts; the lookup
// maps are injected (the generated module supplies a trimmed subset) so this
// file stays a small pure algorithm.

export type IconLookup = {
	readonly fileNames: Readonly<Record<string, string>>;
	readonly fileExtensions: Readonly<Record<string, string>>;
	readonly defaultFile: string;
};

// Ambiguous extensions VS Code resolves through its language service; map the
// common ones explicitly since we don't ship that service.
const EXTRA_EXTENSIONS: Readonly<Record<string, string>> = {
	ts: "typescript",
	tsx: "react_ts",
	js: "javascript",
	jsx: "react",
	cjs: "javascript",
	mjs: "javascript",
	html: "html",
	htm: "html",
	yaml: "yaml",
	yml: "yaml",
};

export const basename = (filePath: string): string => {
	const normalized = filePath.replace(/\\/g, "/");
	const trimmed = normalized.endsWith("/")
		? normalized.slice(0, -1)
		: normalized;
	const slash = trimmed.lastIndexOf("/");
	return slash === -1 ? trimmed : trimmed.slice(slash + 1);
};

export const resolveFileIconName = (
	fileName: string,
	lookup: IconLookup,
): string => {
	const lower = fileName.toLowerCase();

	const named = lookup.fileNames[lower] ?? lookup.fileNames[fileName];
	if (named) return named;

	const dot = lower.indexOf(".");
	if (dot === -1) return lookup.defaultFile;

	const parts = lower.slice(dot + 1).split(".");
	for (let i = 0; i < parts.length; i++) {
		const composite = parts.slice(i).join(".");
		const fromExtra = EXTRA_EXTENSIONS[composite];
		if (fromExtra) return fromExtra;
		const fromMap = lookup.fileExtensions[composite];
		if (fromMap) return fromMap;
	}
	return lookup.defaultFile;
};
