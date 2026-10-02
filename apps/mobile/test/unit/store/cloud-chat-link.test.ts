import { Effect } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { cloudControlClientForWorkspace } from "../../../src/rpc/api-client";
import {
	cloudCatalogAtom,
	setCloudCatalogAccount,
	setCloudCatalogWorkspace,
} from "../../../src/store/cloud-catalog";
import { resolveMobileCloudChatLink } from "../../../src/store/cloud-chat-link";
import { appAtomRegistry } from "../../../src/store/registry";
import { summary } from "../../fixtures/cloud";

const api = vi.hoisted(() => ({
	list: vi.fn(),
	organizations: vi.fn(),
	features: { organizationWorkspaces: true },
}));
vi.mock("~/lib/release-features", () => ({
	mobileReleaseFeatures: api.features,
}));
vi.mock("~/rpc/api-client", () => ({
	organizationControlClientForAccount: vi.fn(() => ({
		"organizations.list": () => Effect.promise(api.organizations),
	})),
	cloudControlClientForWorkspace: vi.fn(() => ({
		"cloud.chats.list": (input: unknown) =>
			Effect.promise(() => api.list(input)),
	})),
}));
const scope = { kind: "organization", organizationId: "org_a" } as const;
const path = "/w/organization/org_a/chat/workspace-1";

describe("mobile authenticated chat links", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.features.organizationWorkspaces = true;
		setCloudCatalogAccount(null);
		setCloudCatalogAccount("account-a");
		api.organizations
			.mockReset()
			.mockResolvedValue([{ id: "org_a", name: "Team", role: "member" }]);
		api.list
			.mockReset()
			.mockResolvedValue({ chats: [{ ...summary(), workspaceScope: scope }] });
	});
	test("resolves an authorized organization chat into the existing session route", async () => {
		expect(await resolveMobileCloudChatLink(path)).toBe(
			"/c/cloud%3Aworkspace-1/session/session-1",
		);
		expect(cloudControlClientForWorkspace).toHaveBeenLastCalledWith(scope);
		expect(api.list).toHaveBeenCalledWith({ scope: "all" });
		expect(appAtomRegistry.get(cloudCatalogAtom)).toMatchObject({
			scope,
			chats: [{ workspaceId: "workspace-1" }],
		});
	});
	test("retains legacy Personal ownership without needing an organization rollout", async () => {
		api.features.organizationWorkspaces = false;
		api.list.mockResolvedValue({ chats: [summary()] });
		await resolveMobileCloudChatLink("/w/personal/chat/workspace-1");
		expect(cloudControlClientForWorkspace).toHaveBeenLastCalledWith({
			kind: "personal",
		});
		expect(api.organizations).not.toHaveBeenCalled();
	});
	test.each([
		"billing",
		"removed",
	])("denies %s membership before querying chat content", async (role) => {
		api.organizations.mockResolvedValue(
			role === "removed" ? [] : [{ id: "org_a", name: "Finance", role }],
		);
		await expect(resolveMobileCloudChatLink(path)).rejects.toThrow(
			"do not have access",
		);
		expect(api.list).not.toHaveBeenCalled();
		expect(appAtomRegistry.get(cloudCatalogAtom).scope).toEqual({
			kind: "personal",
		});
	});
	test("does not query or select an organization when the rollout is off", async () => {
		api.features.organizationWorkspaces = false;
		await expect(resolveMobileCloudChatLink(path)).rejects.toThrow(
			"not enabled",
		);
		expect(api.organizations).not.toHaveBeenCalled();
		expect(api.list).not.toHaveBeenCalled();
	});
	test("requires authentication before querying either catalog", async () => {
		setCloudCatalogAccount(null);
		await expect(resolveMobileCloudChatLink(path)).rejects.toThrow("Sign in");
		expect(cloudControlClientForWorkspace).not.toHaveBeenCalled();
	});
	test.each([
		{ chats: [] },
		{ chats: [summary()] },
	])("does not grant access to absent or differently owned chats", async ({
		chats,
	}) => {
		api.list.mockResolvedValue({ chats });
		await expect(resolveMobileCloudChatLink(path)).rejects.toThrow(
			"do not have access",
		);
		expect(appAtomRegistry.get(cloudCatalogAtom)).toMatchObject({
			scope: { kind: "personal" },
			chats: [],
		});
	});
	test.each([
		"cancel",
		"workspace",
		"account",
	])("ignores late lookups after %s changes", async (change) => {
		const response = Promise.withResolvers<{
			chats: ReturnType<typeof summary>[];
		}>();
		api.list.mockReturnValueOnce(response.promise);
		const controller = new AbortController();
		const pending = resolveMobileCloudChatLink(path, controller.signal);
		await vi.waitFor(() => expect(api.list).toHaveBeenCalled());
		if (change === "cancel") controller.abort();
		if (change === "workspace") {
			setCloudCatalogWorkspace({
				kind: "organization",
				organizationId: "org_b",
			});
			setCloudCatalogWorkspace({ kind: "personal" });
		}
		if (change === "account") {
			setCloudCatalogAccount("account-b");
			setCloudCatalogAccount("account-a");
		}
		response.resolve({ chats: [{ ...summary(), workspaceScope: scope }] });
		await expect(pending).rejects.toThrow("Workspace changed");
		expect(appAtomRegistry.get(cloudCatalogAtom)).toMatchObject({
			scope: { kind: "personal" },
			chats: [],
		});
	});
});
