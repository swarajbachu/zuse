import { afterEach, describe, expect, it, vi } from "vitest";

import {
	faviconUrlForLink,
	hostnameFromLink,
} from "../../src/lib/site-favicon.ts";

describe("site favicon", () => {
	afterEach(() => vi.unstubAllGlobals());

	it.each([
		"zuse",
		"memoize",
	])("uses the desktop protocol with the %s bridge", (bridge) => {
		vi.stubGlobal("window", { [bridge]: {} });
		expect(faviconUrlForLink("https://github.com/docs?q=private#section")).toBe(
			"zuse://site-favicon/github.com",
		);
	});

	it("normalizes international hostnames and omits credentials, ports and paths", () => {
		expect(
			faviconUrlForLink(
				"https://user:password@bücher.de:8443/private?q=secret",
			),
		).toBe("/assets/site-favicon/xn--bcher-kva.de");
	});
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
