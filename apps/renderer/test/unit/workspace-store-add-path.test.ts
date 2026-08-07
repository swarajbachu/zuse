import type { Folder, FolderId } from "@zuse/contracts";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpcClientFactory } = vi.hoisted(() => ({
	rpcClientFactory: vi.fn(),
}));

vi.mock("../../src/lib/rpc-client.ts", () => ({
	getRpcClient: async () => rpcClientFactory(),
}));

import { useWorkspaceStore } from "../../src/store/workspace.ts";

const folder = {
	id: "folder-cloud" as FolderId,
	path: "/home/zuse/project",
	name: "project",
	addedAt: new Date("2026-08-07T00:00:00.000Z"),
} as Folder;

describe("workspace addPath", () => {
	beforeEach(() => {
		useWorkspaceStore.setState({
			folders: [],
			selectedFolderId: null,
			error: null,
		});
		rpcClientFactory.mockReset();
	});

	it("registers an existing path in the active environment", async () => {
		const add = vi.fn(() => Effect.succeed(folder));
		const setSelected = vi.fn(() => Effect.void);
		rpcClientFactory.mockReturnValue({
			"workspace.add": add,
			"workspace.setSelected": setSelected,
		});

		await useWorkspaceStore.getState().addPath(folder.path);

		expect(add).toHaveBeenCalledWith({ path: folder.path });
		expect(setSelected).toHaveBeenCalledWith({ folderId: folder.id });
		expect(useWorkspaceStore.getState()).toMatchObject({
			folders: [folder],
			selectedFolderId: folder.id,
			error: null,
		});
	});
});
