import { FolderId } from "@zuse/contracts";
import { describe, expect, test } from "vitest";
import { openFileBelongsToProject } from "../../src/store/ui.ts";

describe("cloud file context", () => {
	test("keeps a sandbox file open under its logical project", () => {
		const logicalProjectId = FolderId.make("logical-project");
		expect(
			openFileBelongsToProject(
				{
					kind: "text",
					folderId: FolderId.make("sandbox-folder"),
					projectId: logicalProjectId,
					path: "src/app.ts",
					name: "app.ts",
					worktreeId: null,
					view: "edit",
				},
				logicalProjectId,
			),
		).toBe(true);
	});
});
