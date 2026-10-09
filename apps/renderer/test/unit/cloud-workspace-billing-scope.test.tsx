import type { OrganizationRole, WorkspaceScope } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	scope: { kind: "personal" } as WorkspaceScope,
	role: undefined as OrganizationRole | undefined,
}));
vi.mock("../../src/hooks/use-auth.ts", () => ({
	useAuth: () => ({
		isLoading: false,
		isSignedIn: true,
		signingIn: false,
		signIn: vi.fn(),
	}),
}));
vi.mock("../../src/lib/renderer-workspace.ts", () => ({
	rendererWorkspaceSnapshot: () => ({
		scope: fixture.scope,
		key:
			fixture.scope.kind === "personal"
				? "personal"
				: `organization:${fixture.scope.organizationId}`,
		epoch: 1,
	}),
	subscribeRendererWorkspace: () => () => {},
}));
vi.mock("../../src/lib/organization-workspaces.ts", () => ({
	useOrganizationWorkspaces: (
		select: (state: {
			organizations: ReadonlyArray<{
				id: string;
				name: string;
				role: OrganizationRole;
			}>;
		}) => unknown,
	) =>
		select({
			organizations:
				fixture.role === undefined
					? []
					: [{ id: "org_a", name: "Acme", role: fixture.role }],
		}),
}));

import { CloudWorkspacePool } from "../../src/components/settings/cloud-workspace-pool.tsx";

beforeEach(() => {
	fixture.scope = { kind: "personal" };
	fixture.role = undefined;
});

it("identifies Personal billing and keeps subscription state pending until verified", () => {
	const markup = renderToStaticMarkup(<CloudWorkspacePool section="billing" />);
	expect(markup).toContain("Cloud · Personal");
	expect(markup).not.toContain("Subscribe");
	expect(markup).toContain("Manage or cancel your Zuse subscription");
	expect(markup).toContain("Buy credits");
});

it("routes finance-only members to billing even when a content settings page was selected", () => {
	fixture.scope = { kind: "organization", organizationId: "org_a" };
	fixture.role = "billing";
	const markup = renderToStaticMarkup(
		<CloudWorkspacePool section="repositories" />,
	);
	expect(markup).toContain("Cloud · Acme");
	expect(markup).toContain("Manage or cancel your Zuse subscription");
	expect(markup).toContain("Buy credits");
	expect(markup).not.toContain("Connect GitHub");
});

it.each([
	"admin",
	"billing",
	"member",
	undefined,
] as const)("identifies organization billing and limits financial actions for %s", (role) => {
	fixture.scope = { kind: "organization", organizationId: "org_a" };
	fixture.role = role;
	const markup = renderToStaticMarkup(<CloudWorkspacePool section="billing" />);
	expect(markup).toContain(`Cloud · ${role === undefined ? "org_a" : "Acme"}`);
	expect(markup).not.toContain("Cloud · Personal");
	if (role === "admin" || role === "billing") {
		expect(markup).not.toContain("Subscribe");
		// Billing remains accessible before activation and after cancellation.
		expect(markup).toContain("Manage or cancel your Zuse subscription");
		expect(markup).toContain("Buy credits");
	} else {
		expect(markup).not.toContain("Subscribe");
		expect(markup).not.toContain("Manage or cancel your Zuse subscription");
		expect(markup).not.toContain("Buy credits");
		expect(markup).toContain("Only workspace admins and billing members");
	}
});
