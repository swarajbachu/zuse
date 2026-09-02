import { describe, expect, it } from "vitest";

import {
	faviconUrlForLink,
	hostnameFromLink,
} from "../../src/lib/site-favicon.ts";

describe("site favicon", () => {
	it("normalizes an external link to its hostname", () => {
		expect(hostnameFromLink("https://GitHub.com/openai/codex?q=1")).toBe(
			"github.com",
		);
	});

	it("rejects local and non-http links", () => {
		expect(hostnameFromLink("/docs/readme.md")).toBeNull();
		expect(faviconUrlForLink("file:///tmp/readme.md")).toBeNull();
	});

	it("builds a stable favicon endpoint", () => {
		expect(faviconUrlForLink("https://example.com/docs")).toBe(
			"/assets/site-favicon/example.com",
		);
	});
});
