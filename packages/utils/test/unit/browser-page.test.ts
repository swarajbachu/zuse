import { describe, expect, test } from "vitest";

import {
	BROWSER_PAGE_HEADERS,
	clampedText,
	escapeHtml,
} from "../../src/browser-page.js";

describe("browser page helpers", () => {
	test("escapes every character that can break out of markup", () => {
		expect(escapeHtml(`<script>alert("x" & 'y')</script>`)).toBe(
			"&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;",
		);
		expect(escapeHtml("plain text")).toBe("plain text");
	});

	test("clamps, trims, and escapes untrusted text", () => {
		expect(clampedText("  spaced  ", 60)).toBe("spaced");
		expect(clampedText("<b>", 60)).toBe("&lt;b&gt;");
		expect(clampedText("x".repeat(10), 5)).toBe(`${"x".repeat(4)}…`);
	});

	test("treats empty and missing text as absent", () => {
		expect(clampedText(undefined, 60)).toBeNull();
		expect(clampedText("   ", 60)).toBeNull();
	});

	test("keeps callback responses uncacheable and resource-free", () => {
		expect(BROWSER_PAGE_HEADERS["cache-control"]).toBe("no-store");
		expect(BROWSER_PAGE_HEADERS["referrer-policy"]).toBe("no-referrer");
		expect(BROWSER_PAGE_HEADERS["x-content-type-options"]).toBe("nosniff");
		expect(BROWSER_PAGE_HEADERS["content-security-policy"]).toContain(
			"default-src 'none'",
		);
	});
});
