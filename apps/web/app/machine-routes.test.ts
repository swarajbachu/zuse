import { describe, expect, it } from "vitest";
import { GET as getHomepageMarkdown } from "./home.md/route";
import { GET as getLlmsText } from "./llms.txt/route";
import {
	GET as getOpenApi,
	OPTIONS as getOpenApiOptions,
	POST as postOpenApi,
} from "./openapi.json/route";
import sitemap from "./sitemap";

describe("machine-readable routes", () => {
	it("serves homepage and instruction Markdown with cache-safe negotiation headers", async () => {
		for (const response of [getHomepageMarkdown(), getLlmsText()]) {
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("text/markdown");
			expect(response.headers.get("vary")).toContain("Accept");
			expect((await response.text()).length).toBeGreaterThan(500);
		}
	});

	it("publishes a cross-origin-readable OpenAPI document", async () => {
		const response = getOpenApi();
		expect(response.status).toBe(200);
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		expect(await response.json()).toMatchObject({ openapi: "3.1.0" });
	});

	it("returns structured errors and an explicit preflight contract for OpenAPI", async () => {
		const unsupported = postOpenApi();
		expect(unsupported.status).toBe(405);
		expect(await unsupported.json()).toMatchObject({
			error: { code: "METHOD_NOT_ALLOWED", resolution: expect.any(String) },
		});

		const preflight = getOpenApiOptions();
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-methods")).toBe("GET");
	});

	it("includes Zuse developer resources in the sitemap", () => {
		expect(sitemap().some((entry) => entry.url.endsWith("/developers"))).toBe(
			true,
		);
	});
});
