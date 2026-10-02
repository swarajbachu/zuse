import { Effect } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { cloudControlClientForWorkspace } from "../../../src/rpc/api-client";
import {
	cloudCatalogAtom,
	setCloudCatalogAccount,
	setCloudCatalogWorkspace,
} from "../../../src/store/cloud-catalog";
import { createCloudChatSharingController } from "../../../src/store/cloud-chat-sharing";
import { appAtomRegistry } from "../../../src/store/registry";
import { summary } from "../../fixtures/cloud";

const api = vi.hoisted(() => ({
	get: vi.fn(),
	save: vi.fn(),
	organization: vi.fn(),
	features: { organizationWorkspaces: true },
}));
vi.mock("~/lib/release-features", () => ({
	mobileReleaseFeatures: api.features,
}));
vi.mock("~/rpc/api-client", () => ({
	cloudControlClientForWorkspace: vi.fn(() => ({
		"cloud.sharing.get": (input: unknown) =>
			Effect.promise(() => api.get(input)),
		"cloud.sharing.update": (input: unknown) =>
			Effect.promise(() => api.save(input)),
	})),
	organizationControlClientForAccount: vi.fn(() => ({
		"organizations.get": (input: unknown) =>
			Effect.promise(() => api.organization(input)),
	})),
}));
const scope = { kind: "organization", organizationId: "org_a" } as const;
const policy = {
	audience: "private",
	permission: "view",
	creatorSubject: "account-a",
	creatorMembershipId: "member-a",
	grants: [{ membershipId: "member-b", permission: "edit" }],
} as const;
const sharing = { policy, revision: 4, canManageSharing: true };
const organization = {
	organization: { id: "org_a", name: "Team A", role: "member" },
	currentUserId: "account-a",
	members: [],
	invitations: [],
};
const input = {
	audience: "organization",
	permission: "edit",
	grants: [],
	expectedRevision: 4,
} as const;

describe("organization chat sharing", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.features.organizationWorkspaces = true;
		setCloudCatalogAccount(null);
		setCloudCatalogAccount("account-a");
		setCloudCatalogWorkspace(scope);
		appAtomRegistry.update(cloudCatalogAtom, (catalog) => ({
			...catalog,
			organizations: [{ id: "org_a", name: "Team A", role: "member" as const }],
			chats: [{ ...summary(), workspaceScope: scope }],
		}));
		api.get.mockReset().mockResolvedValue(sharing);
		api.save.mockReset().mockResolvedValue({ ...sharing, revision: 5 });
		api.organization.mockReset().mockResolvedValue(organization);
	});
	test("reads and updates the selected chat through the existing API with its revision", async () => {
		const controller = createCloudChatSharingController("workspace-1");
		expect(await controller.load()).toEqual({ sharing, organization });
		await controller.save(input);
		expect(cloudControlClientForWorkspace).toHaveBeenCalledWith(scope);
		expect(api.get).toHaveBeenCalledWith({ workspaceId: "workspace-1" });
		expect(api.organization).toHaveBeenCalledWith({ organizationId: "org_a" });
		expect(api.save).toHaveBeenCalledWith({
			...input,
			workspaceId: "workspace-1",
		});
	});
	test("copying a link emits only the authenticated route and performs no grant mutation", () => {
		const link = new URL(
			createCloudChatSharingController("workspace-1").link(),
		);
		expect(link.pathname).toBe("/w/organization/org_a/chat/workspace-1");
		expect(link.search).toBe("");
		expect(api.save).not.toHaveBeenCalled();
	});
	test("a retained dialog cannot save or copy after switching away and back", async () => {
		const controller = createCloudChatSharingController("workspace-1");
		setCloudCatalogWorkspace({ kind: "personal" });
		setCloudCatalogWorkspace(scope);
		await expect(controller.save(input)).rejects.toThrow("access changed");
		expect(() => controller.link()).toThrow("access changed");
		expect(api.save).not.toHaveBeenCalled();
	});
	test("late reads cannot populate another account", async () => {
		const pending = Promise.withResolvers<typeof sharing>();
		api.get.mockReturnValueOnce(pending.promise);
		const read = createCloudChatSharingController("workspace-1").load();
		await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
		setCloudCatalogAccount("account-b");
		pending.resolve(sharing);
		await expect(read).rejects.toThrow("access changed");
	});
	test("revision conflicts are surfaced without retrying or changing the revision", async () => {
		api.save.mockRejectedValue(new Error("conflict"));
		await expect(
			createCloudChatSharingController("workspace-1").save(input),
		).rejects.toThrow("conflict");
		expect(api.save).toHaveBeenCalledOnce();
	});
	test("a wrong-organization roster is rejected", async () => {
		api.organization.mockResolvedValue({
			...organization,
			organization: { ...organization.organization, id: "org_b" },
		});
		await expect(
			createCloudChatSharingController("workspace-1").load(),
		).rejects.toThrow("Unexpected organization");
	});
	test.each([
		"unknown",
		"personal",
		"cross-org",
		"billing",
		"removed",
		"flag-off",
	])("does not create a sharing client for %s access", (reason) => {
		if (reason === "unknown")
			appAtomRegistry.update(cloudCatalogAtom, (catalog) => ({
				...catalog,
				chats: [],
			}));
		if (reason === "personal" || reason === "cross-org")
			appAtomRegistry.update(cloudCatalogAtom, (catalog) => ({
				...catalog,
				chats: [
					{
						...summary(),
						workspaceScope:
							reason === "personal"
								? { kind: "personal" as const }
								: { kind: "organization" as const, organizationId: "org_b" },
					},
				],
			}));
		if (reason === "billing" || reason === "removed")
			appAtomRegistry.update(cloudCatalogAtom, (catalog) => ({
				...catalog,
				organizations:
					reason === "removed"
						? []
						: [{ id: "org_a", name: "Team A", role: "billing" as const }],
			}));
		if (reason === "flag-off") api.features.organizationWorkspaces = false;
		expect(() => createCloudChatSharingController("workspace-1")).toThrow();
		expect(cloudControlClientForWorkspace).not.toHaveBeenCalled();
	});
});
