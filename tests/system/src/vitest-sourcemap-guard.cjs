"use strict";

const convertSourceMap = require("convert-source-map");
const fromSource = convertSourceMap.fromSource.bind(convertSourceMap);

// tsx's minified CJS register contains the literal string it uses to append
// inline source maps. convert-source-map mistakes that string literal for a
// real comment and attempts to decode the rest of the bundle as base64. Keep
// Vitest's stack formatter best-effort: an invalid embedded map must never
// abort the desktop system suite or hide the underlying test failure.
convertSourceMap.fromSource = (source) => {
	try {
		return fromSource(source);
	} catch (error) {
		if (error instanceof SyntaxError) return null;
		throw error;
	}
};
