import { BROWSER_PAGE_HEADERS } from "@zuse/utils/browser-page";
import { describe, expect, it } from "vitest";

import {
	renderAuthCallbackPage,
	renderNotFoundPage,
} from "../../src/auth-callback-page.ts";

const nowMs = Date.parse("2026-08-14T10:11:12.000Z");

describe("auth callback page", () => {
	it("issues a signed-in ticket for the account flow", () => {
		const page = renderAuthCallbackPage({
			flow: "account",
			nowMs,
			outcome: "success",
		});

		expect(page).toContain("signed in");
		expect(page).toContain("ZS-20260814-1011");
		expect(page).toContain("Signed in · Zuse");
		expect(page).not.toContain("Linear");
	});

	it("voids the ticket and shows the provider reason on failure", () => {
		const page = renderAuthCallbackPage({
			detail: "The user denied the request.",
			flow: "account",
			nowMs,
			outcome: "error",
		});

		expect(page).toContain("didn’t finish");
		expect(page).toContain("The user denied the request.");
		expect(page).toContain("Void");
		expect(page).not.toContain("Admitted");
	});

	it("stamps the Linear flow instead of ticketing it", () => {
		const page = renderAuthCallbackPage({
			flow: "linear",
			nowMs,
			outcome: "success",
		});

		expect(page).toContain("Linear");
		expect(page).toContain("Linear connected · Zuse");
		expect(page).toContain("2026.08.14");
		expect(page).not.toContain("Admit");
	});

	it("escapes provider-supplied text", () => {
		const page = renderAuthCallbackPage({
			detail: '<script>alert("x")</script>',
			flow: "account",
			nowMs,
			outcome: "error",
		});

		expect(page).not.toContain("<script>alert");
		expect(page).toContain("&lt;script&gt;");
	});

	it("clamps runaway provider messages", () => {
		const page = renderAuthCallbackPage({
			detail: "x".repeat(400),
			flow: "linear",
			nowMs,
			outcome: "error",
		});

		expect(page).toContain(`${"x".repeat(179)}…`);
		expect(page).not.toContain("x".repeat(181));
	});

	it("stays self-contained and theme aware", () => {
		for (const page of [
			renderAuthCallbackPage({ flow: "account", nowMs, outcome: "success" }),
			renderAuthCallbackPage({ flow: "linear", nowMs, outcome: "success" }),
			renderNotFoundPage(),
		]) {
			expect(page).not.toMatch(/(?:src|href)="https?:/u);
			expect(page).not.toContain("<script");
			expect(page).toContain("prefers-color-scheme:dark");
			expect(page).toContain("prefers-reduced-motion:reduce");
		}
	});

	it("keeps callback responses uncacheable", () => {
		expect(BROWSER_PAGE_HEADERS["cache-control"]).toBe("no-store");
		expect(BROWSER_PAGE_HEADERS["referrer-policy"]).toBe("no-referrer");
		expect(BROWSER_PAGE_HEADERS["content-security-policy"]).toContain(
			"default-src 'none'",
		);
	});
});
