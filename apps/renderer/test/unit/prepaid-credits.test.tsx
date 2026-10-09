import { BillingPrepaidBalance } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { PrepaidCredits } from "../../src/components/settings/prepaid-credits.tsx";

const render = (balance: BillingPrepaidBalance | null, busy = false) =>
	renderToStaticMarkup(
		<PrepaidCredits
			balance={balance}
			busy={busy}
			onBuy={vi.fn()}
			onRefresh={vi.fn()}
		/>,
	);
it("shows remaining invoice credit, all purchase amounts, and rollover policy", () => {
	const markup = render(
		BillingPrepaidBalance.make({
			available: true,
			creditCents: 7500,
			debitCents: 0,
			currency: "usd",
		}),
	);
	expect(markup).toContain("$75.00 available");
	for (const value of ["$10.00", "$25.00", "$50.00", "$100.00"])
		expect(markup).toContain(value);
	expect(markup).toContain("including subscriptions");
	expect(markup).toContain("Unused credit rolls forward");
	expect(markup).toContain("spending cap stay the same");
	expect(markup.match(/<button[^>]*>[^<]*Buy credits/)?.[0]).not.toContain(
		'disabled=""',
	);
});
it("does not show a fabricated zero balance when loading failed and disables buying", () => {
	const markup = render(null);
	expect(markup).toContain("Balance unavailable");
	expect(markup).not.toContain("$0.00 available");
	expect(markup.match(/<select[^>]*>/)?.[0]).toContain("disabled");
});
it("shows a refund debit and disables unsupported checkout", () => {
	const markup = render(
		BillingPrepaidBalance.make({
			available: false,
			creditCents: 0,
			debitCents: 2500,
			currency: "usd",
		}),
	);
	expect(markup).toContain("$25.00 owed on future invoices");
	expect(markup).toContain("not enabled for this workspace yet");
	expect(markup.match(/<select[^>]*>/)?.[0]).toContain("disabled");
});
it("all controls stay compact and purchases disable while opening checkout", () => {
	const markup = render(
		BillingPrepaidBalance.make({
			available: true,
			creditCents: 0,
			debitCents: 0,
			currency: "usd",
		}),
		true,
	);
	for (const control of markup.match(/<(?:button|select)[^>]*>/g) ?? [])
		expect(control).toContain("h-7");
	expect(markup.match(/<select[^>]*>/)?.[0]).toContain("disabled");
});
