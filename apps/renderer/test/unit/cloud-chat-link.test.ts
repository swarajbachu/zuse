import { cloudChatRoute } from "@zuse/client-runtime/environment-scope";
import { CloudWorkspaceOpError } from "@zuse/contracts";
import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	enabled: true,
	list: vi.fn(),
	client: vi.fn(),
	organizations: vi.fn(),
	open: vi.fn(),
}));
vi.mock("../../src/lib/cloud-control-client.ts", () => ({
	getCloudControlClient: mocks.client,
}));
vi.mock("../../src/lib/cloud-workspaces.ts", () => ({
	openCloudChat: mocks.open,
}));
vi.mock("../../src/lib/organization-workspaces.ts", () => ({
	organizationWorkspacesAvailable: () => mocks.enabled,
	loadOrganizationWorkspaces: mocks.organizations,
}));

import { openCloudChatLink } from "../../src/lib/cloud-chat-link.ts";
import { observeRendererAccount } from "../../src/lib/renderer-account.ts";
import {
	rendererWorkspaceSnapshot,
	selectRendererWorkspace,
} from "../../src/lib/renderer-workspace.ts";

const scope = { kind: "organization", organizationId: "org_a" } as const;
const path = cloudChatRoute({ scope, workspaceId: "cloud_a" });
const summary = { workspaceId: "cloud_a", workspaceScope: scope };
beforeEach(() => {
	vi.resetAllMocks();
	mocks.enabled = true;
	observeRendererAccount(null);
	observeRendererAccount("alice");
	mocks.client.mockResolvedValue({ "cloud.chats.list": mocks.list });
	mocks.list.mockReturnValue(Effect.succeed({ chats: [summary] }));
	mocks.organizations.mockResolvedValue([{ id: "org_a", role: "member" }]);
});

it("selects only the authorized link's workspace and opens the existing chat", async () => {
	await openCloudChatLink(path);
	expect(mocks.organizations).toHaveBeenCalledWith(true);
	expect(mocks.client).toHaveBeenCalledWith(scope);
	expect(mocks.list).toHaveBeenCalledWith({ scope: "all" });
	expect(rendererWorkspaceSnapshot().scope).toEqual(scope);
	expect(mocks.open).toHaveBeenCalledWith(summary);
});

it.each([
	"billing",
	"removed",
])("denies %s membership without loading content or switching", async (role) => {
	mocks.organizations.mockResolvedValue([{ id: "org_a", role }]);
	await expect(openCloudChatLink(path)).rejects.toThrow(
		"chat_link_unavailable",
	);
	expect(mocks.client).not.toHaveBeenCalled();
	expect(mocks.open).not.toHaveBeenCalled();
	expect(rendererWorkspaceSnapshot().scope).toEqual({ kind: "personal" });
});

it("does not turn a guessed or cross-owner ID into access", async () => {
	mocks.list.mockReturnValue(
		Effect.succeed({
			chats: [
				{
					...summary,
					workspaceScope: { kind: "organization", organizationId: "org_b" },
				},
			],
		}),
	);
	await expect(openCloudChatLink(path)).rejects.toThrow(
		"chat_link_unavailable",
	);
	expect(mocks.open).not.toHaveBeenCalled();
	expect(rendererWorkspaceSnapshot().scope).toEqual({ kind: "personal" });
});

it("keeps Personal links Personal and does not require organization membership", async () => {
	const personal = { workspaceId: "personal_chat" };
	mocks.list.mockReturnValue(Effect.succeed({ chats: [personal] }));
	await openCloudChatLink(
		cloudChatRoute({
			scope: { kind: "personal" },
			workspaceId: personal.workspaceId,
		}),
	);
	expect(mocks.organizations).not.toHaveBeenCalled();
	expect(mocks.client).toHaveBeenCalledWith({ kind: "personal" });
	expect(mocks.open).toHaveBeenCalledWith(personal);
});

it("fails closed while organization rollout is disabled", async () => {
	mocks.enabled = false;
	await expect(openCloudChatLink(path)).rejects.toThrow(
		"chat_link_unavailable",
	);
	expect(mocks.client).not.toHaveBeenCalled();
	expect(mocks.organizations).toHaveBeenCalledWith(true);
});

it.each([
	"account",
	"workspace",
])("ignores a late catalog after %s changes", async (change) => {
	const response = Promise.withResolvers<{ chats: (typeof summary)[] }>();
	mocks.list.mockReturnValue(Effect.promise(() => response.promise));
	const pending = openCloudChatLink(path);
	await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
	if (change === "account") observeRendererAccount("bob");
	else
		selectRendererWorkspace({ kind: "organization", organizationId: "org_b" });
	response.resolve({ chats: [summary] });
	await expect(pending).rejects.toThrow("changed");
	expect(mocks.open).not.toHaveBeenCalled();
});

it("presents permission loss as unavailable without selecting the target", async () => {
	mocks.list.mockReturnValue(
		Effect.fail(new CloudWorkspaceOpError({ code: "not-allowed" })),
	);
	await expect(openCloudChatLink(path)).rejects.toThrow(
		"chat_link_unavailable",
	);
	expect(mocks.open).not.toHaveBeenCalled();
	expect(rendererWorkspaceSnapshot().scope).toEqual({ kind: "personal" });
});

it.each([
	"/w/personal/chat/%",
	"/w/organization/%2F/chat/id",
])("rejects malformed link scopes before requests: %s", async (pathname) => {
	await expect(openCloudChatLink(pathname)).rejects.toThrow();
	expect(mocks.client).not.toHaveBeenCalled();
});
