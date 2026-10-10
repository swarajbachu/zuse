import { Effect } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { organizationControlClientForAccount } from "../../../src/rpc/api-client";
import {
	cloudCatalogAtom,
	setCloudCatalogAccount,
	setCloudCatalogWorkspace,
} from "../../../src/store/cloud-catalog";
import { createOrganizationMembersController } from "../../../src/store/organization-members";
import { appAtomRegistry } from "../../../src/store/registry";

const api = vi.hoisted(() => ({
	get: vi.fn(),
	invite: vi.fn(),
	role: vi.fn(),
	remove: vi.fn(),
	revoke: vi.fn(),
	features: { organizationWorkspaces: true },
}));
vi.mock("~/lib/release-features", () => ({
	mobileReleaseFeatures: api.features,
}));
vi.mock("~/rpc/api-client", () => ({
	organizationControlClientForAccount: vi.fn(() => ({
		"organizations.get": (input: unknown) =>
			Effect.promise(() => api.get(input)),
		"organizations.invite": (input: unknown) =>
			Effect.promise(() => api.invite(input)),
		"organizations.setRole": (input: unknown) =>
			Effect.promise(() => api.role(input)),
		"organizations.removeMember": (input: unknown) =>
			Effect.promise(() => api.remove(input)),
		"organizations.revokeInvite": (input: unknown) =>
			Effect.promise(() => api.revoke(input)),
	})),
}));
const scope = { kind: "organization", organizationId: "org_a" } as const;
const details = {
	organization: { id: "org_a", name: "Team A", role: "admin" },
	currentUserId: "account-a",
	members: [],
	invitations: [],
};
const setRole = (role: "admin" | "member" | "billing") =>
	appAtomRegistry.update(cloudCatalogAtom, (catalog) => ({
		...catalog,
		organizations: [{ id: "org_a", name: "Team A", role }],
	}));

describe("workspace-bound member management", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.features.organizationWorkspaces = true;
		setCloudCatalogAccount(null);
		setCloudCatalogAccount("account-a");
		setRole("admin");
		setCloudCatalogWorkspace(scope);
		api.get.mockReset().mockResolvedValue(details);
		for (const method of [api.invite, api.role, api.remove, api.revoke])
			method.mockReset().mockResolvedValue(undefined);
	});
	test("all operations use the selected organization and shared account client", async () => {
		const controller = createOrganizationMembersController();
		expect(await controller.load()).toEqual(details);
		await controller.invite("finance@example.com", "billing");
		await controller.setRole("member-b", "admin");
		await controller.remove("member-c");
		await controller.revoke("invite-a");
		expect(api.get).toHaveBeenCalledWith({ organizationId: "org_a" });
		expect(api.invite).toHaveBeenCalledWith({
			organizationId: "org_a",
			email: "finance@example.com",
			role: "billing",
		});
		expect(api.role).toHaveBeenCalledWith({
			organizationId: "org_a",
			memberId: "member-b",
			role: "admin",
		});
		expect(api.remove).toHaveBeenCalledWith({
			organizationId: "org_a",
			memberId: "member-c",
		});
		expect(api.revoke).toHaveBeenCalledWith({
			organizationId: "org_a",
			invitationId: "invite-a",
		});
	});
	test.each([
		"member",
		"billing",
	] as const)("%s can read membership but cannot mutate it", async (role) => {
		setRole(role);
		const controller = createOrganizationMembersController();
		await controller.load();
		await expect(controller.invite("a@example.com", "member")).rejects.toThrow(
			"access changed",
		);
		await expect(controller.setRole("member-b", "admin")).rejects.toThrow(
			"access changed",
		);
		await expect(controller.remove("member-b")).rejects.toThrow(
			"access changed",
		);
		await expect(controller.revoke("invite-a")).rejects.toThrow(
			"access changed",
		);
		for (const method of [api.invite, api.role, api.remove, api.revoke])
			expect(method).not.toHaveBeenCalled();
	});
	test("retained confirmations refuse requests after switching away and back", async () => {
		const controller = createOrganizationMembersController();
		setCloudCatalogWorkspace({ kind: "personal" });
		setCloudCatalogWorkspace(scope);
		await expect(controller.remove("member-b")).rejects.toThrow(
			"access changed",
		);
		expect(api.remove).not.toHaveBeenCalled();
	});
	test("demotion blocks retained mutation callbacks without waiting for a scope change", async () => {
		const controller = createOrganizationMembersController();
		setRole("member");
		await expect(controller.revoke("invite-a")).rejects.toThrow(
			"access changed",
		);
		expect(api.revoke).not.toHaveBeenCalled();
	});
	test("rejects a late roster after an account switch", async () => {
		const result = Promise.withResolvers<typeof details>();
		api.get.mockReturnValueOnce(result.promise);
		const pending = createOrganizationMembersController().load();
		await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
		setCloudCatalogAccount("account-b");
		result.resolve(details);
		await expect(pending).rejects.toThrow("access changed");
	});
	test("rejects a response belonging to another organization", async () => {
		api.get.mockResolvedValue({
			...details,
			organization: { ...details.organization, id: "org_b" },
		});
		await expect(createOrganizationMembersController().load()).rejects.toThrow(
			"Unexpected organization",
		);
	});
	test.each([
		"personal",
		"signed-out",
		"removed",
		"flag-off",
	])("does not create a client for %s access", (reason) => {
		if (reason === "personal") setCloudCatalogWorkspace({ kind: "personal" });
		if (reason === "signed-out") setCloudCatalogAccount(null);
		if (reason === "removed")
			appAtomRegistry.update(cloudCatalogAtom, (catalog) => ({
				...catalog,
				organizations: [],
			}));
		if (reason === "flag-off") api.features.organizationWorkspaces = false;
		expect(() => createOrganizationMembersController()).toThrow();
		expect(organizationControlClientForAccount).not.toHaveBeenCalled();
	});
});
