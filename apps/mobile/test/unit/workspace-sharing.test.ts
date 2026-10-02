import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import WorkspaceSharing from "../../app/workspace-sharing";
import { cloudWorkspaceAdminSnapshot } from "../../src/store/cloud-catalog";

const state = vi.hoisted(() => ({
	values: new Map<string, unknown>(),
	features: { organizationWorkspaces: true },
}));
vi.mock("@effect/atom-react", () => ({
	useAtomValue: (key: string) => state.values.get(key),
}));
vi.mock("expo-router", () => ({ Stack: { Screen: () => null } }));
vi.mock("react-native", () => ({ View: "div", Text: "span" }));
vi.mock("~/components/ui/button", () => ({ Button: "button" }));
vi.mock("~/components/selector-row", () => ({ SelectorRow: () => null }));
vi.mock("~/lib/release-features", () => ({
	mobileReleaseFeatures: state.features,
}));
vi.mock("~/store/auth", () => ({ authAccountAtom: "account" }));
vi.mock("~/rpc/api-client", () => ({
	cloudControlClientForWorkspace: vi.fn(),
}));
vi.mock("~/store/cloud-catalog", () => ({
	cloudCatalogAtom: "catalog",
	cloudCatalogGeneration: () => 1,
	cloudWorkspaceAdminSnapshot: vi.fn(() => ({
		isCurrent: () => true,
		scope: { kind: "organization", organizationId: "org_a" },
	})),
}));
const catalog = {
	accountId: "account-a",
	scope: { kind: "organization", organizationId: "org_a" },
	organizations: [{ id: "org_a", name: "Team A", role: "admin" }],
};
const render = () => renderToStaticMarkup(createElement(WorkspaceSharing));
describe("Sharing Defaults screen access", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.features.organizationWorkspaces = true;
		state.values.set("account", { id: "account-a" });
		state.values.set("catalog", catalog);
	});
	test("identifies the organization, future-chat behavior, and administrator access", () => {
		const markup = render();
		expect(markup).toContain("Team A");
		expect(markup).toContain("Existing chats keep their sharing settings");
		expect(markup).toContain("organization administrators");
		expect(cloudWorkspaceAdminSnapshot).toHaveBeenCalledOnce();
	});
	test.each([
		"member",
		"billing",
		"personal",
		"signed-out",
		"stale-account",
		"removed",
		"flag-off",
	])("does not mount configuration for %s", (reason) => {
		if (reason === "member" || reason === "billing")
			state.values.set("catalog", {
				...catalog,
				organizations: [{ id: "org_a", name: "Team A", role: reason }],
			});
		if (reason === "personal")
			state.values.set("catalog", { ...catalog, scope: { kind: "personal" } });
		if (reason === "signed-out") state.values.set("account", null);
		if (reason === "stale-account")
			state.values.set("account", { id: "account-b" });
		if (reason === "removed")
			state.values.set("catalog", { ...catalog, organizations: [] });
		if (reason === "flag-off") state.features.organizationWorkspaces = false;
		expect(render()).toContain(
			"Organization administrators can manage sharing defaults",
		);
		expect(cloudWorkspaceAdminSnapshot).not.toHaveBeenCalled();
	});
});
