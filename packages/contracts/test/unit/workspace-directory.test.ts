import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { WorkspaceDirectoryListing } from "../../src/workspace.ts";

describe("WorkspaceDirectoryListing", () => {
	it("decodes a resolved path with directory and file entries", () => {
		const listing = Schema.decodeUnknownSync(WorkspaceDirectoryListing)({
			path: "/home/user/Developer",
			parent: "/home/user",
			entries: [
				{
					name: "project",
					path: "/home/user/Developer/project",
					kind: "directory",
				},
				{
					name: "notes.txt",
					path: "/home/user/Developer/notes.txt",
					kind: "file",
				},
			],
		});
		expect(listing.entries.map((entry) => entry.kind)).toEqual([
			"directory",
			"file",
		]);
	});
});
