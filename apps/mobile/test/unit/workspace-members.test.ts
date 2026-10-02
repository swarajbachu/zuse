import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import WorkspaceMembers from "../../app/workspace-members";
import { createOrganizationMembersController } from "../../src/store/organization-members";

const state = vi.hoisted(() => ({
	values: new Map<string, unknown>(),
	features: { organizationWorkspaces: true },
}));
vi.mock("@effect/atom-react", () => ({
	useAtomValue: (key: string) => state.values.get(key),
}));
vi.mock("expo-router", () => ({ Stack: { Screen: () => null } }));
vi.mock("react-native", () => ({
	View: "div",
	Text: "span",
	ScrollView: "section",
	Alert: { alert: vi.fn() },
}));
vi.mock("~/components/ui/button", () => ({ Button: "button" }));
vi.mock("~/components/ui/input", () => ({ Input: "input" }));
vi.mock("~/components/selector-row", () => ({ SelectorRow: () => null }));
vi.mock("~/lib/release-features", () => ({
	mobileReleaseFeatures: state.features,
}));
vi.mock("~/store/auth", () => ({ authAccountAtom: "account" }));
vi.mock("~/store/cloud-catalog", () => ({
	cloudCatalogAtom: "catalog",
	cloudCatalogGeneration: () => 1,
}));
vi.mock("~/store/organization-members", () => ({
	createOrganizationMembersController: vi.fn(() => ({
		isCurrent: () => true,
		load: vi.fn(),
	})),
}));
const catalog = {
	accountId: "account-a",
	scope: { kind: "organization", organizationId: "org_a" },
	organizations: [{ id: "org_a", name: "Team A", role: "admin" }],
};
const render = () => renderToStaticMarkup(createElement(WorkspaceMembers));

describe("Members screen access boundary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.features.organizationWorkspaces = true;
		state.values.set("account", { id: "account-a" });
		state.values.set("catalog", catalog);
	});
	test.each([
		"admin",
		"member",
		"billing",
	])("mounts the selected organization's roster for %s", (role) => {
		state.values.set("catalog", {
			...catalog,
			organizations: [{ ...catalog.organizations[0], role }],
		});
		expect(render()).toContain("Loading…");
		expect(createOrganizationMembersController).toHaveBeenCalledOnce();
	});
	test.each([
		"personal",
		"signed-out",
		"stale-account",
		"removed",
		"flag-off",
	])("does not mount a member client for %s", (reason) => {
		if (reason === "personal")
			state.values.set("catalog", { ...catalog, scope: { kind: "personal" } });
		if (reason === "signed-out") state.values.set("account", null);
		if (reason === "stale-account")
			state.values.set("account", { id: "account-b" });
		if (reason === "removed")
			state.values.set("catalog", { ...catalog, organizations: [] });
		if (reason === "flag-off") state.features.organizationWorkspaces = false;
		expect(render()).toContain("Select an organization you belong to");
		expect(createOrganizationMembersController).not.toHaveBeenCalled();
	});
});
