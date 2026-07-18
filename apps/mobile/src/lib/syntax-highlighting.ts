export type SyntaxPalette = {
	comment: string;
	keyword: string;
	literal: string;
	number: string;
	plain: string;
	string: string;
};

export type SyntaxPiece = { key: string; text: string; color: string };

export const LIGHT_SYNTAX: SyntaxPalette = {
	comment: "#71806d",
	keyword: "#9b32a8",
	literal: "#b04452",
	number: "#9c6429",
	plain: "#252622",
	string: "#56852f",
};

export const DARK_SYNTAX: SyntaxPalette = {
	comment: "#7f8b7b",
	keyword: "#d66ee4",
	literal: "#f26d78",
	number: "#d89958",
	plain: "#d3d6cd",
	string: "#9ac66d",
};

const TOKEN_PATTERN =
	/(\/\/.*$|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:async|await|break|case|catch|class|const|continue|default|else|export|extends|false|finally|for|from|function|if|implements|import|in|interface|let|new|null|of|return|switch|throw|true|try|type|typeof|undefined|while|yield)\b|\b\d+(?:\.\d+)?\b)/g;

export const MAX_HIGHLIGHT_CHARS = 4_000;
export const MAX_HIGHLIGHT_CACHE_ENTRIES = 2_048;
const syntaxCache = new WeakMap<
	SyntaxPalette,
	Map<string, readonly SyntaxPiece[]>
>();

export function tokenizeCodeLine(
	text: string,
	palette: SyntaxPalette,
): readonly SyntaxPiece[] {
	let cache = syntaxCache.get(palette);
	if (cache === undefined) {
		cache = new Map();
		syntaxCache.set(palette, cache);
	}
	const displayText =
		text.length > MAX_HIGHLIGHT_CHARS
			? `${text.slice(0, MAX_HIGHLIGHT_CHARS)}…`
			: text;
	const cached = cache.get(displayText);
	if (cached !== undefined) {
		cache.delete(displayText);
		cache.set(displayText, cached);
		return cached;
	}

	const pieces: SyntaxPiece[] = [];
	let cursor = 0;
	for (const match of displayText.matchAll(TOKEN_PATTERN)) {
		const index = match.index ?? cursor;
		if (index > cursor) {
			pieces.push({
				key: `${cursor}:plain`,
				text: displayText.slice(cursor, index),
				color: palette.plain,
			});
		}
		const token = match[0];
		const color =
			token.startsWith("//") || token.startsWith("/*")
				? palette.comment
				: token.startsWith('"') ||
						token.startsWith("'") ||
						token.startsWith("`")
					? palette.string
					: /^\d/.test(token)
						? palette.number
						: /^(?:true|false|null|undefined)$/.test(token)
							? palette.literal
							: palette.keyword;
		pieces.push({ key: `${index}:token`, text: token, color });
		cursor = index + token.length;
	}
	if (cursor < displayText.length) {
		pieces.push({
			key: `${cursor}:plain`,
			text: displayText.slice(cursor),
			color: palette.plain,
		});
	}
	cache.set(displayText, pieces);
	if (cache.size > MAX_HIGHLIGHT_CACHE_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	return pieces;
}
