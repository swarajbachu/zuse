import { ChatId, EnvironmentId } from "@zuse/contracts";
import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock("../../src/lib/session-timeline-client-bus.ts", () => ({
	getRendererClientBus: () => mocks,
}));

import { observeRendererAccount } from "../../src/lib/renderer-account.ts";
import { workspaceSharing } from "../../src/lib/workspace-sharing.ts";

const ref = {
	environmentId: EnvironmentId.make("remote"),
	chatId: ChatId.make("chat"),
};
beforeEach(() => {
	vi.resetAllMocks();
	observeRendererAccount(null);
	observeRendererAccount("alice");
});

it("uses the selected environment's existing client without opening another connection", async () => {
	const list = vi.fn(() => Effect.succeed([]));
	mocks.client.mockReturnValue({ "organizations.list": list });
	await expect(workspaceSharing.organizations(ref)).resolves.toEqual([]);
	expect(mocks.client).toHaveBeenCalledWith(ref.environmentId);
	expect(list).toHaveBeenCalledWith({});
});

it("scopes grant changes to the chat and sends user identity, never client-supplied actor claims", async () => {
	const setGrant = vi.fn(() => Effect.void);
	mocks.client.mockReturnValue({ "organizations.setWorkspaceGrant": setGrant });
	await workspaceSharing.setGrant(ref, "org", "user", "viewer");
	await workspaceSharing.setGrant(ref, "org", "user", null);
	expect(setGrant.mock.calls).toEqual([
		[
			{
				organizationId: "org",
				chatId: ref.chatId,
				userId: "user",
				role: "viewer",
			},
		],
		[{ organizationId: "org", chatId: ref.chatId, userId: "user", role: null }],
	]);
});

it("fails closed when the selected environment is disconnected", async () => {
	mocks.client.mockReturnValue(null);
	await expect(workspaceSharing.setShared(ref, "org", true)).rejects.toThrow(
		"Environment is not connected",
	);
});

it("rejects a completed grant mutation after an account switch instead of refreshing under the new account", async () => {
	const completion = Promise.withResolvers<void>();
	mocks.client.mockReturnValue({
		"organizations.setWorkspaceGrant": () =>
			Effect.promise(() => completion.promise),
	});
	const refresh = vi.fn();
	const pending = workspaceSharing
		.setGrant(ref, "org", "user", "viewer")
		.then(refresh);
	observeRendererAccount("bob");
	observeRendererAccount("alice");
	completion.resolve();
	await expect(pending).rejects.toThrow("connection account changed");
	expect(refresh).not.toHaveBeenCalled();
});
