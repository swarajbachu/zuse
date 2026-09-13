import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { LEGAL_PAGES } from "@/lib/legal-pages";
import { proxy } from "./proxy";

const makeRequest = (path: string, accept?: string) =>
	new NextRequest(`https://zuse.sh${path}`, {
		headers: accept ? { Accept: accept } : undefined,
	});

describe("proxy", () => {
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
		expect(response.headers.get("vary")).toBe(
			"Accept, Accept-Encoding, Accept-Language, Cookie, X-Vercel-IP-Country",
		);
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

	it("allows public legal and trust pages through content negotiation", () => {
		for (const { path } of LEGAL_PAGES) {
			const response = proxy(makeRequest(path, "text/markdown"));
			expect(response.status).toBe(200);
			expect(response.headers.get("x-middleware-next")).toBe("1");
		}
	});
});

describe("homepage language preference", () => {
	const request = (path: string, headers: Record<string, string> = {}) =>
		new NextRequest(`https://zuse.sh${path}`, {
			headers: { Accept: "text/html", ...headers },
		});

	it("redirects first visits using browser quality order and preserves queries", () => {
		const response = proxy(
			request("/?utm_source=launch", {
				"Accept-Language": "fr;q=0.5,de;q=0.9",
			}),
		);
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(
			"https://zuse.sh/de?utm_source=launch",
		);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("vary")).toContain("Accept-Language");
		expect(response.headers.get("vary")).toContain("Cookie");
	});
	it("lets saved English and other explicit choices beat browser and IP hints", () => {
		const hints = { "Accept-Language": "fr", "x-vercel-ip-country": "DE" };
		expect(
			proxy(request("/", { ...hints, Cookie: "zuse-language=en" })).status,
		).toBe(200);
		expect(
			proxy(request("/", { ...hints, Cookie: "zuse-language=ko" })).headers.get(
				"location",
			),
		).toBe("https://zuse.sh/ko");
	});
	it("uses the IP country only without a supported browser preference", () => {
		expect(
			proxy(
				request("/", { "Accept-Language": "ru", "x-vercel-ip-country": "TW" }),
			).headers.get("location"),
		).toBe("https://zuse.sh/zh-Hant");
		expect(
			proxy(
				request("/", { "Accept-Language": "en", "x-vercel-ip-country": "TW" }),
			).status,
		).toBe(200);
	});
	it("ignores corrupt and pseudo-language cookies", () => {
		for (const value of ["corrupt", "en-XA", "../../fr"]) {
			expect(
				proxy(
					request("/", {
						Cookie: `zuse-language=${value}`,
						"Accept-Language": "ja",
					}),
				).headers.get("location"),
			).toBe("https://zuse.sh/ja");
		}
	});
	it("honors direct localized URLs without overwriting the saved choice", () => {
		const response = proxy(
			request("/fr", { Cookie: "zuse-language=de", "Accept-Language": "ko" }),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("set-cookie")).toBeNull();
	});
	it("makes explicit English links sticky and prevents automatic redirect loops", () => {
		const response = proxy(request("/en", { "Accept-Language": "fr" }));
		expect(response.status).toBe(307);
		expect(response.headers.get("set-cookie")).toContain("zuse-language=en;");
		expect(response.headers.get("cache-control")).toBe("private, no-store");
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
