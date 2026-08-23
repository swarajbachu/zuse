import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
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
});
