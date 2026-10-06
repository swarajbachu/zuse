import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("../../src/hooks/use-auth.ts", () => ({
	useAuth: () => ({ isSignedIn: true, isLoading: false }),
}));

import { OrganizationsPane } from "../../src/components/settings/organizations-pane.tsx";

it("uses the settings width without a second organization selector in workspace settings", () => {
	const markup = renderToStaticMarkup(
		<OrganizationsPane organizationId="org-a" />,
	);
	expect(markup).not.toContain("Your organizations");
	expect(markup).not.toContain("max-w-xl");
	expect(markup).toContain("flex flex-col gap-4");
	expect(markup).toContain('role="status"');
	expect(markup).toContain("Refresh");
});

it("keeps account-level joining out of an organization's own settings", () => {
	const markup = renderToStaticMarkup(
		<OrganizationsPane organizationId="org-a" />,
	);
	expect(markup).not.toContain("Join with GitHub");
	expect(markup).not.toContain("Create an organization");
});
