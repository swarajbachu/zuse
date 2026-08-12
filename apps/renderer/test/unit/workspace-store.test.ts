import { Folder, FolderId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import { registerFolder } from "../../src/store/workspace.ts";

const folder = (id: string, path: string) =>
	Folder.make({
		id: FolderId.make(id),
		path,
		name: path.split("/").at(-1) ?? path,
		addedAt: new Date("2026-08-12T00:00:00.000Z"),
	});

describe("registerFolder", () => {
	it("does not append a streamed folder again when the add request resolves", () => {
		const existing = folder("project-1", "/projects/test");
		expect(
			registerFolder({ folders: [existing], selectedFolderId: null }, existing),
		).toEqual({ folders: [existing], selectedFolderId: existing.id });
	});

	it("keeps selection aligned when the same path has a canonical existing id", () => {
		const existing = folder("project-1", "/projects/test");
		const duplicate = folder("project-2", "/projects/test");
		expect(
			registerFolder(
				{ folders: [existing], selectedFolderId: null },
				duplicate,
			),
		).toEqual({ folders: [existing], selectedFolderId: existing.id });
	});

	it("appends a different project", () => {
		const existing = folder("project-1", "/projects/one");
		const added = folder("project-2", "/projects/two");
		expect(
			registerFolder(
				{ folders: [existing], selectedFolderId: existing.id },
				added,
			),
		).toEqual({ folders: [existing, added], selectedFolderId: added.id });
	});
});
