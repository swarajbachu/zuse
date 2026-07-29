import { FsEntry } from "@zuse/contracts";
import { describe, expect, it, vi } from "vitest";
import { reconcileFileTreePaths } from "../../src/lib/file-tree-reconciliation.ts";

const file = (path: string) =>
	FsEntry.make({
		name: path.split("/").at(-1) ?? path,
		path,
		kind: "file",
	});

const directory = (path: string) =>
	FsEntry.make({
		name: path.split("/").at(-1) ?? path,
		path,
		kind: "directory",
	});

describe("file tree reconciliation", () => {
	it("refreshes only the changed file's parent", async () => {
		const listDirectory = vi.fn(async (path: string) =>
			path === "src" ? [file("src/app.ts"), file("src/new.ts")] : [],
		);
		const result = await reconcileFileTreePaths({
			changedPaths: ["src/new.ts"],
			knownPaths: new Set(["src/", "src/app.ts", "README.md"]),
			listDirectory,
		});

		expect(listDirectory).toHaveBeenCalledTimes(1);
		expect(listDirectory).toHaveBeenCalledWith("src");
		expect(result.operations).toEqual([{ type: "add", path: "src/new.ts" }]);
		expect([...result.paths]).toContain("README.md");
	});

	it("removes a deleted directory and its known descendants locally", async () => {
		const listDirectory = vi.fn(async () => [file("README.md")]);
		const result = await reconcileFileTreePaths({
			changedPaths: ["src"],
			knownPaths: new Set([
				"src/",
				"src/app.ts",
				"src/components/",
				"src/components/button.tsx",
				"README.md",
			]),
			listDirectory,
		});

		expect(result.operations).toEqual([
			{ type: "remove", path: "src/app.ts" },
			{ type: "remove", path: "src/components/button.tsx" },
			{ type: "remove", path: "src/components/" },
			{ type: "remove", path: "src/" },
		]);
		expect([...result.paths]).toEqual(["README.md"]);
	});

	it("walks a newly added directory without rescanning unrelated paths", async () => {
		const listDirectory = vi.fn(async (path: string) => {
			if (path === "") return [directory("generated"), file("README.md")];
			if (path === "generated") return [file("generated/result.ts")];
			return [];
		});
		const result = await reconcileFileTreePaths({
			changedPaths: ["generated"],
			knownPaths: new Set(["README.md"]),
			listDirectory,
		});

		expect(listDirectory.mock.calls).toEqual([[""], ["generated"]]);
		expect(result.operations).toEqual([
			{ type: "add", path: "generated/" },
			{ type: "add", path: "generated/result.ts" },
		]);
	});

	it("surfaces transient listing failures so the caller can retry", async () => {
		await expect(
			reconcileFileTreePaths({
				changedPaths: ["src/index.ts"],
				knownPaths: new Set(["src/", "src/index.ts"]),
				listDirectory: async () => {
					throw new Error("filesystem busy");
				},
			}),
		).rejects.toThrow("filesystem busy");
	});
});
