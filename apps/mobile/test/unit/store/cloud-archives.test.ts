import { Effect } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { cloudControlClientForWorkspace } from "../../../src/rpc/api-client";
import { createCloudArchiveController } from "../../../src/store/cloud-archives";
import {
	setCloudCatalogAccount,
	setCloudCatalogWorkspace,
} from "../../../src/store/cloud-catalog";
import { summary } from "../../fixtures/cloud";

const api = vi.hoisted(() => ({
	list: vi.fn(),
	restore: vi.fn(),
	delete: vi.fn(),
}));
vi.mock("~/rpc/api-client", () => ({
	cloudControlClientForWorkspace: vi.fn(() => ({
		"cloud.chats.list": (input: unknown) =>
			Effect.promise(() => api.list(input)),
		"cloud.workspaces.unarchive": (input: unknown) =>
			Effect.promise(() => api.restore(input)),
		"cloud.workspaces.delete": (input: unknown) =>
			Effect.promise(() => api.delete(input)),
	})),
}));
const organization = { kind: "organization", organizationId: "org_a" } as const;

describe("workspace-scoped mobile archives", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setCloudCatalogAccount(null);
		setCloudCatalogAccount("account-a");
		api.list.mockReset().mockResolvedValue({ chats: [summary()] });
		api.restore.mockReset().mockResolvedValue(undefined);
		api.delete.mockReset().mockResolvedValue(undefined);
	});
	test.each([
		{ kind: "personal" } as const,
		organization,
	])("lists and mutates in $kind only", async (scope) => {
		setCloudCatalogWorkspace(scope);
		api.list.mockResolvedValue({
			chats: [{ ...summary(), workspaceScope: scope }],
		});
		const controller = createCloudArchiveController();
		await controller.list();
		await controller.restore("workspace-1");
		await controller.list();
		await controller.delete("workspace-1");
		expect(cloudControlClientForWorkspace).toHaveBeenLastCalledWith(scope);
		expect(api.list).toHaveBeenCalledWith({ scope: "archived" });
		expect(api.restore).toHaveBeenCalledWith({ workspaceId: "workspace-1" });
		expect(api.delete).toHaveBeenCalledWith({ workspaceId: "workspace-1" });
	});
	test("refuses destructive actions on IDs not loaded from this archive", async () => {
		const controller = createCloudArchiveController();
		await expect(controller.delete("workspace-1")).rejects.toThrow(
			"Refresh archived chats",
		);
		await controller.list();
		await expect(controller.restore("other")).rejects.toThrow(
			"Refresh archived chats",
		);
		expect(api.restore).not.toHaveBeenCalled();
		expect(api.delete).not.toHaveBeenCalled();
	});
	test("rejects mixed workspace ownership", async () => {
		setCloudCatalogWorkspace(organization);
		const controller = createCloudArchiveController();
		await expect(controller.list()).rejects.toThrow("different workspace");
		await expect(controller.delete("workspace-1")).rejects.toThrow(
			"Refresh archived chats",
		);
		expect(api.delete).not.toHaveBeenCalled();
	});
	test.each([
		"account",
		"workspace",
	])("rejects late lists and stale confirmations across %s changes", async (change) => {
		const controller = createCloudArchiveController();
		await controller.list();
		const late = Promise.withResolvers<{
			chats: ReturnType<typeof summary>[];
		}>();
		api.list.mockReturnValueOnce(late.promise);
		const pending = controller.list();
		await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
		if (change === "account") {
			setCloudCatalogAccount("account-b");
			setCloudCatalogAccount("account-a");
		} else {
			setCloudCatalogWorkspace(organization);
			setCloudCatalogWorkspace({ kind: "personal" });
		}
		late.resolve({ chats: [summary()] });
		await expect(pending).rejects.toThrow("Workspace changed");
		await expect(controller.delete("workspace-1")).rejects.toThrow(
			"Workspace changed",
		);
		expect(api.delete).not.toHaveBeenCalled();
	});
	test("does not resurrect an archive entry from a list started before restoration", async () => {
		const controller = createCloudArchiveController();
		await controller.list();
		const late = Promise.withResolvers<{
			chats: ReturnType<typeof summary>[];
		}>();
		api.list.mockReturnValueOnce(late.promise);
		const pending = controller.list();
		await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
		await controller.restore("workspace-1");
		late.resolve({ chats: [summary()] });
		await expect(pending).rejects.toThrow("Archived chats changed");
		await expect(controller.delete("workspace-1")).rejects.toThrow(
			"Refresh archived chats",
		);
	});
});
