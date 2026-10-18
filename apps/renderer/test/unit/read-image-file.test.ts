import { FolderId, WorktreeId } from "@zuse/contracts";
import { expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ read: vi.fn(), dispatch: vi.fn() }));
vi.mock("../../src/lib/local-device-client-bus.ts", () => ({
	readLocalExternalFile: mocks.read,
}));
vi.mock("../../src/lib/file-tree-client-bus.ts", () => ({
	dispatchFileTreeCommand: mocks.dispatch,
}));
vi.mock("../../src/lib/rpc-client.ts", () => ({
	getLocalEnvironmentId: () => "local",
}));

import { readImageFile } from "../../src/lib/read-image-file.ts";

test("reads screenshots outside the workspace through local file access", async () => {
	const result = { kind: "binary", bytes: new Uint8Array([137, 80, 78, 71]) };
	mocks.read.mockResolvedValueOnce(result);
	expect(
		await readImageFile({
			kind: "external",
			absPath: "/tmp/preview.png",
			name: "preview.png",
		}),
	).toBe(result);
	expect(mocks.read).toHaveBeenCalledWith("/tmp/preview.png");
});

test("routes workspace images to their owning environment", async () => {
	const result = { kind: "binary", bytes: new Uint8Array([137, 80, 78, 71]) };
	mocks.dispatch.mockResolvedValueOnce({ result });
	const folderId = FolderId.make("folder");
	const worktreeId = WorktreeId.make("worktree");
	expect(
		await readImageFile({
			kind: "text",
			folderId,
			worktreeId,
			environmentId: "remote",
			path: "preview.png",
			name: "preview.png",
		}),
	).toBe(result);
	expect(mocks.dispatch).toHaveBeenCalledWith(
		expect.objectContaining({
			kind: "fs.readFile",
			ref: { environmentId: "remote", folderId, worktreeId, rootPath: "" },
			payload: { folderId, path: "preview.png", worktreeId },
		}),
	);
});
