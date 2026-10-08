import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import {
	type CloudHostingMode,
	CloudHostingSettings,
} from "../../src/components/settings/cloud-hosting-settings.tsx";

const render = (
	paidSubscription: boolean | null,
	{
		canManageBilling = true,
		canManageProviders = true,
		activeMode = null as CloudHostingMode | null,
	} = {},
) =>
	renderToStaticMarkup(
		<CloudHostingSettings
			paidSubscription={paidSubscription}
			loading={paidSubscription === null}
			canManageBilling={canManageBilling}
			canManageProviders={canManageProviders}
			activeMode={activeMode}
			selectedProviderId={null}
			snapshot={null}
			busy={null}
			onCheckout={vi.fn()}
			onManage={vi.fn()}
			onChanged={async () => {}}
		/>,
	);

it("presents Zuse hosting and the user's own cloud account as separate choices", () => {
	const markup = render(true, { activeMode: "zuse" });
	expect(markup).toContain('aria-label="Hosting"');
	expect(markup).toContain("Zuse Cloud");
	expect(markup).toContain("Manage subscription");
	expect(markup).toContain("In use");
	expect(markup).toContain("Your cloud account");
	expect(markup).toContain("No subscription needed");
	expect(markup).not.toContain("Subscribe ·");
});
it("offers checkout only after verifying there is no subscription", () => {
	expect(render(false)).toContain("Subscribe");
	expect(render(null)).not.toContain("Subscribe");
	expect(render(null)).not.toContain(">No subscription<");
});
it("keeps checkout secondary while the user's own hosting is in use", () => {
	const markup = render(false, { activeMode: "provider" });
	const subscribe = markup.match(/<button[^>]*>[^<]*Subscribe/)?.[0] ?? "";
	expect(subscribe).not.toContain("bg-primary");
	// Own-account hosting is only marked in use once a key is actually connected.
	expect(markup).not.toContain("In use");
});
it("respects billing and provider permissions while retaining status", () => {
	expect(render(true, { canManageBilling: false })).not.toContain(
		"Manage subscription",
	);
	expect(render(false, { canManageBilling: false })).not.toContain("Subscribe");
	expect(render(true, { canManageBilling: false })).toContain("Subscribed");
	expect(render(true, { canManageProviders: false })).not.toContain(
		'aria-expanded="false"',
	);
});
it("keeps every visible control at the compact height", () => {
	for (const control of render(false).match(/<button[^>]*>/g) ?? [])
		expect(control).toContain("h-7");
});
it("does not offer switching to Zuse Cloud without a subscription and an overriding key", () => {
	expect(render(true, { activeMode: "provider" })).not.toContain(
		"Use Zuse Cloud",
	);
	expect(render(false, { activeMode: "provider" })).not.toContain(
		"Use Zuse Cloud",
	);
});
