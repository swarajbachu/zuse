import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { LEGAL_PAGES } from "@/lib/legal-pages";
import { config, proxy } from "./proxy";

const makeRequest = (path: string, accept?: string) =>
	new NextRequest(`https://zuse.sh${path}`, {
		headers: accept ? { Accept: accept } : undefined,
	});

describe("proxy", () => {
	it.each([
		"/_next/static/chunks/app.js",
		"/_next/image?url=%2Fog.png&w=640&q=75",
	])("skips negotiation for framework asset %s", (url) => {
		expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
	});

	it.each([
		"/",
		"/en",
		"/fr",
		"/home.md",
		"/api/missing",
		"/missing-page",
	])("preserves negotiation and errors for %s", (url) => {
		expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
	});

	it("serves the homepage Markdown representation at the same URL", () => {
		const response = proxy(makeRequest("/", "text/markdown"));
		expect(response.status).toBe(200);
		expect(response.headers.get("x-middleware-rewrite")).toBe(
			"https://zuse.sh/home.md",
		);
		expect(response.headers.get("vary")).toContain("Accept");
		expect(response.headers.get("link")).toContain("text/markdown");
	});

	it("keeps HTML as the browser default and marks the cache variant", () => {
		const response = proxy(makeRequest("/", "text/html, */*;q=0.8"));
		expect(response.status).toBe(200);
		expect(response.headers.get("x-middleware-next")).toBe("1");
		expect(response.headers.get("vary")).toBe("Accept, Accept-Encoding");
	});

	it("returns a structured 406 for unsupported homepage media types", async () => {
		const response = proxy(makeRequest("/", "application/xml"));
		expect(response.status).toBe(406);
		expect(await response.json()).toMatchObject({
			error: { code: "NOT_ACCEPTABLE", resolution: expect.any(String) },
		});
	});

	it("returns a recoverable Markdown 404 for unknown paths", async () => {
		const response = proxy(
			makeRequest("/path-that-does-not-exist", "text/markdown"),
		);
		expect(response.status).toBe(404);
		expect(response.headers.get("content-type")).toContain("text/markdown");
		expect(await response.text()).toContain("/sitemap.xml");
	});

	it("returns structured JSON for unknown API routes", async () => {
		const response = proxy(makeRequest("/api/path-that-does-not-exist"));
		expect(response.status).toBe(404);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toMatchObject({
			error: {
				code: "NOT_FOUND",
				resolution: expect.stringContaining("openapi"),
			},
		});
	});

	it("allows the documentation root to reach its configured redirect", () => {
		const response = proxy(makeRequest("/docs", "text/markdown"));
		expect(response.status).toBe(200);
		expect(response.headers.get("x-middleware-next")).toBe("1");
	});

	it("allows the guided review demo through content negotiation", () => {
		const response = proxy(makeRequest("/demo/guided-review", "text/markdown"));
		expect(response.status).toBe(200);
		expect(response.headers.get("x-middleware-next")).toBe("1");
	});

	it("allows public legal and trust pages through content negotiation", () => {
		for (const { path } of LEGAL_PAGES) {
			const response = proxy(makeRequest(path, "text/markdown"));
			expect(response.status).toBe(200);
			expect(response.headers.get("x-middleware-next")).toBe("1");
		}
	});
});

describe("homepage language handling", () => {
	const request = (path: string, headers: Record<string, string> = {}) =>
		new NextRequest(`https://zuse.sh${path}`, {
			headers: { Accept: "text/html", ...headers },
		});

	it("serves English at / whatever the browser language, cookie or country says", () => {
		const hints: Record<string, string>[] = [
			{ "Accept-Language": "fr;q=0.5,de;q=0.9" },
			{ "Accept-Language": "ja", "x-vercel-ip-country": "JP" },
			{ "x-vercel-ip-country": "TW" },
			{ Cookie: "zuse-language=ko", "Accept-Language": "fr" },
		];
		for (const headers of hints) {
			const response = proxy(request("/?utm_source=launch", headers));
			expect(response.status).toBe(200);
			expect(response.headers.get("location")).toBeNull();
			expect(response.headers.get("x-middleware-next")).toBe("1");
		}
	});

	it("keeps the English homepage cacheable: no private/no-store and no personalised Vary", () => {
		const response = proxy(request("/", { "Accept-Language": "fr" }));
		expect(response.headers.get("cache-control")).toBeNull();
		const vary = response.headers.get("vary") ?? "";
		for (const header of ["Accept-Language", "Cookie", "X-Vercel-IP-Country"])
			expect(vary).not.toContain(header);
	});

	it("honors direct localized URLs without touching the saved choice", () => {
		const response = proxy(
			request("/fr", { Cookie: "zuse-language=de", "Accept-Language": "ko" }),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("set-cookie")).toBeNull();
	});

	it("keeps /en as a sticky link to the English homepage", () => {
		const response = proxy(request("/en", { "Accept-Language": "fr" }));
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe("https://zuse.sh/");
		expect(response.headers.get("set-cookie")).toContain("zuse-language=en;");
	});

	it("does not redirect Markdown or non-landing routes", () => {
		expect(
			proxy(
				request("/", { Accept: "text/markdown", "Accept-Language": "fr" }),
			).headers.get("x-middleware-rewrite"),
		).toBe("https://zuse.sh/home.md");
		for (const path of ["/privacy", "/docs", "/download", "/api/waitlist"]) {
			expect(proxy(request(path, { "Accept-Language": "fr" })).status).toBe(
				200,
			);
		}
	});
});
