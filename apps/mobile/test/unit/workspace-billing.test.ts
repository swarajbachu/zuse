import { Effect } from "effect";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { WorkspaceBilling } from "../../src/components/workspace-billing";
import { cloudControlClientForWorkspace } from "../../src/rpc/api-client";

const state = vi.hoisted(() => ({
	values: new Map<string, unknown>(),
	epoch: 1,
	features: { organizationWorkspaces: true },
	press: undefined as (() => void | Promise<void>) | undefined,
	portal: vi.fn(),
	open: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
	useAtomValue: (key: string) => state.values.get(key),
}));
vi.mock("expo-router", () => ({ Stack: { Screen: () => null } }));
vi.mock("react-native", () => ({
	View: "div",
	Text: "span",
	Linking: { openURL: state.open },
}));
vi.mock("~/components/ui/button", () => ({
	Button: ({ onPress }: { onPress: () => void | Promise<void> }) => {
		state.press = onPress;
		return createElement("button", { type: "button" }, "Manage billing");
	},
}));
vi.mock("~/components/workspace-switcher", () => ({
	WorkspaceSwitcher: () => null,
}));
vi.mock("~/lib/release-features", () => ({
	mobileReleaseFeatures: state.features,
}));
vi.mock("~/store/auth", () => ({ authAccountAtom: "account" }));
vi.mock("~/store/cloud-catalog", () => ({
	cloudCatalogAtom: "catalog",
	cloudCatalogGeneration: () => state.epoch,
	cloudWorkspaceSnapshot: () => {
		const epoch = state.epoch;
		const catalog = state.values.get("catalog") as { scope: unknown };
		return { scope: catalog.scope, isCurrent: () => epoch === state.epoch };
	},
}));
vi.mock("~/rpc/api-client", () => ({
	cloudControlClientForWorkspace: vi.fn(() => ({
		"machines.billingPortal": () => Effect.promise(state.portal),
	})),
}));
const scope = { kind: "organization", organizationId: "org_a" } as const;
const selectOrganization = (role: string) =>
	state.values.set("catalog", {
		accountId: "account-a",
		scope,
		organizations: [{ id: "org_a", name: "Team A", role }],
	});
const render = () => renderToStaticMarkup(createElement(WorkspaceBilling));

describe("workspace billing entry points", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.press = undefined;
		state.epoch++;
		state.features.organizationWorkspaces = true;
		state.values.set("account", { id: "account-a" });
		state.values.set("catalog", {
			accountId: "account-a",
			scope: { kind: "personal" },
			organizations: [],
		});
		state.portal
			.mockReset()
			.mockResolvedValue({ portalUrl: "https://billing.example/portal" });
		state.open.mockResolvedValue(undefined);
	});
	test("Personal uses its existing separate billing portal", async () => {
		expect(render()).toContain("Personal billing");
		state.press?.();
		await vi.waitFor(() =>
			expect(state.open).toHaveBeenCalledWith("https://billing.example/portal"),
		);
		expect(cloudControlClientForWorkspace).toHaveBeenCalledWith({
			kind: "personal",
		});
	});
	test.each([
		"admin",
		"billing",
	])("%s membership opens the selected organization's portal", async (role) => {
		selectOrganization(role);
		const markup = render();
		expect(markup).toContain("Team A billing");
		expect(markup.includes("billing-only membership")).toBe(role === "billing");
		state.press?.();
		await vi.waitFor(() => expect(state.open).toHaveBeenCalled());
		expect(cloudControlClientForWorkspace).toHaveBeenCalledWith(scope);
	});
	test.each([
		"member",
		"removed",
	])("does not mount billing controls for %s membership", (role) => {
		selectOrganization(role);
		expect(render()).not.toContain("Manage billing");
		expect(state.press).toBeUndefined();
		expect(state.portal).not.toHaveBeenCalled();
	});
	test("rejects a stale account catalog", () => {
		state.values.set("account", { id: "account-b" });
		expect(render()).not.toContain("Manage billing");
	});
	test("keeps organization billing behind the mobile rollout flag", () => {
		selectOrganization("admin");
		state.features.organizationWorkspaces = false;
		expect(render()).not.toContain("Manage billing");
	});
	test("does not open a late portal URL after a workspace switch", async () => {
		const response = Promise.withResolvers<{ portalUrl: string }>();
		state.portal.mockReturnValueOnce(response.promise);
		render();
		const pending = state.press?.();
		await vi.waitFor(() => expect(state.portal).toHaveBeenCalled());
		state.epoch++;
		response.resolve({ portalUrl: "https://billing.example/old-workspace" });
		await pending;
		expect(state.open).not.toHaveBeenCalled();
	});
	test("does not request a portal from a stale screen callback", async () => {
		render();
		state.epoch++;
		await state.press?.();
		expect(state.portal).not.toHaveBeenCalled();
		expect(state.open).not.toHaveBeenCalled();
	});
});
