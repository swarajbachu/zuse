import { BROWSER_PAGE_HEADERS } from "@zuse/utils/browser-page";
import { describe, expect, it } from "vitest";

import { renderMcpCallbackPage } from "../../src/mcp/mcp-callback-page.ts";

const nowMs = Date.parse("2026-08-14T10:11:12.000Z");

describe("mcp callback page", () => {
	it("stamps the authorized server", () => {
		const page = renderMcpCallbackPage({
			nowMs,
			outcome: "success",
			serverLabel: "mcp.example.com",
		});

		expect(page).toContain("Connected");
		expect(page).toContain("mcp.example.com");
		expect(page).toContain("Authorized");
		expect(page).toContain("2026.08.14");
	});

	it("reports a denied authorization instead of a connected stamp", () => {
		const page = renderMcpCallbackPage({
			detail: "access_denied",
			nowMs,
			outcome: "error",
			serverLabel: "mcp.example.com",
		});

		expect(page).toContain("Not<br>connected");
		expect(page).toContain("access_denied");
		expect(page).toContain("Declined");
	});

	it("works without a server label", () => {
		const page = renderMcpCallbackPage({ nowMs, outcome: "success" });

		expect(page).toContain("This MCP server is authorized");
		expect(page).not.toContain("undefined");
	});

	it("escapes provider-supplied text", () => {
		const page = renderMcpCallbackPage({
			detail: '<script>alert("x")</script>',
			nowMs,
			outcome: "error",
			serverLabel: "<img src=x>",
		});

		expect(page).not.toContain("<script>alert");
		expect(page).not.toContain("<img src=x>");
		expect(page).toContain("&lt;script&gt;");
	});

	it("stays self-contained and theme aware", () => {
		const page = renderMcpCallbackPage({ nowMs, outcome: "success" });

		expect(page).not.toMatch(/(?:src|href)="https?:/u);
		expect(page).not.toContain("<script");
		expect(page).toContain("prefers-color-scheme:dark");
		expect(page).toContain("prefers-reduced-motion:reduce");
		expect(BROWSER_PAGE_HEADERS["cache-control"]).toBe("no-store");
		expect(BROWSER_PAGE_HEADERS["content-security-policy"]).toContain(
			"default-src 'none'",
		);
	});
});
