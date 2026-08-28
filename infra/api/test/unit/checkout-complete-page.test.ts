import { BROWSER_PAGE_HEADERS } from "@zuse/utils/browser-page";
import { describe, expect, test } from "vitest";

import { renderCheckoutCompletePage } from "../../src/checkout-complete-page.ts";

const purchasedAtMs = Date.parse("2026-08-14T10:11:12.000Z");

describe("checkout completion page", () => {
	test("renders the purchased order", () => {
		const page = renderCheckoutCompletePage({
			amount: { cents: 1_900, currency: "usd" },
			orderRef: "ZS-EF123456",
			productName: "Persistent Standard",
			purchasedAtMs,
			status: "paid",
		});

		expect(page).toContain("Persistent Standard");
		expect(page).toContain("$19.00");
		expect(page).toContain("ZS-EF123456");
		expect(page).toContain("2026.08.14 10:11 UTC");
		expect(page).toContain("Paid");
	});

	test("degrades to a courtesy receipt without order details", () => {
		const page = renderCheckoutCompletePage({
			productName: "Zuse subscription",
			purchasedAtMs,
			status: "pending",
		});

		expect(page).toContain("Zuse subscription");
		expect(page).toContain("Awaiting confirmation");
		expect(page).not.toContain("NaN");
		expect(page).not.toContain("undefined");
	});

	test("states plainly when the checkout did not complete", () => {
		const page = renderCheckoutCompletePage({
			productName: "Zuse subscription",
			purchasedAtMs,
			status: "failed",
		});

		expect(page).toContain("Not completed");
		expect(page).toContain("Nothing was charged");
	});

	test("escapes provider-supplied text", () => {
		const page = renderCheckoutCompletePage({
			orderRef: "<img src=x>",
			productName: '<script>alert("x")</script>',
			purchasedAtMs,
			status: "paid",
		});

		expect(page).not.toContain("<script>alert");
		expect(page).not.toContain("<img src=x>");
		expect(page).toContain("&lt;script&gt;");
	});

	test("stays self-contained and theme aware", () => {
		const page = renderCheckoutCompletePage({
			productName: "Persistent Standard",
			purchasedAtMs,
			status: "paid",
		});

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
