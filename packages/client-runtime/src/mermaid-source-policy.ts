/*
 * Copyright (c) 2025-present Mohamed Boudra.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Modified for Zuse on 2026-08-23; see THIRD_PARTY_NOTICES.md.
 */

/**
 * Mermaid may load external images while it is still constructing a diagram,
 * before its strict-mode SVG sanitization runs. Model-generated diagrams are
 * therefore untrusted input: reject resource-bearing syntax before handing it
 * to Mermaid and show the source block instead.
 *
 * This intentionally rejects every shape-data object (`@{ ... }`). Mermaid
 * parses those objects as YAML, whose aliases and alternate key forms make a
 * narrow `img`/`icon` key filter unsafe without using Mermaid's own parser.
 * Formatting-only `<br>` and `<i>` labels remain available; all other HTML and
 * numeric entities fail closed.
 *
 * Upstream context: https://github.com/mermaid-js/mermaid/issues/7645
 */
const UNSAFE_MERMAID_SOURCE =
	/@\s*\{|url\s*\(|@import\b|themecss|&#|<(?!\/?(?:br|i)\s*\/?>)[a-z!?/]/iu;

const ESCAPED_CODE_POINT =
	/\\(?:u\{([0-9a-fA-F]{1,8})\}|U([0-9a-fA-F]{8})|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2}))/gu;

const decodeCodePoint = (hex: string): string => {
	const value = Number.parseInt(hex, 16);
	if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) {
		throw new RangeError("Invalid Unicode code point");
	}
	return String.fromCodePoint(value);
};

/** Decode escape forms Mermaid/YAML can interpret so a denylisted token cannot
 * be hidden behind quoted Unicode escapes. Invalid code points fail closed. */
const normalizedMermaidSource = (source: string): string | null => {
	try {
		return source
			.replace(
				ESCAPED_CODE_POINT,
				(_match, braced, long, short, byte: string | undefined) =>
					decodeCodePoint(braced ?? long ?? short ?? byte ?? ""),
			)
			.replace(/["'`\\]/gu, "");
	} catch {
		return null;
	}
};

export const containsUnsafeMermaidSource = (source: string): boolean => {
	if (UNSAFE_MERMAID_SOURCE.test(source)) return true;
	const normalized = normalizedMermaidSource(source);
	return normalized === null || UNSAFE_MERMAID_SOURCE.test(normalized);
};

/** Fresh objects keep Mermaid's mutable configuration isolated per client. */
export const mermaidSecurityConfig = () => ({
	startOnLoad: false,
	securityLevel: "strict" as const,
	secure: [
		"secure",
		"securityLevel",
		"startOnLoad",
		"maxTextSize",
		"suppressErrorRendering",
		"maxEdges",
		"htmlLabels",
		"theme",
		"themeVariables",
		"themeCSS",
	],
	suppressErrorRendering: true,
	htmlLabels: false,
	flowchart: { htmlLabels: false },
	class: { htmlLabels: false },
});
