import { ReviewGuideChapter } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	isChapterReviewed,
	liveHunkIds,
	NEW_SINCE_GUIDE_ID,
	projectGuide,
	reviewChapter,
	withoutFileHunks,
} from "../../src/review-guide-view.ts";

const patch = (path: string, body: ReadonlyArray<string>) => ({
	path,
	patch: `${[`--- a/${path}`, `+++ b/${path}`, ...body].join("\n")}\n`,
});

const patches = [
	patch("src/api.ts", ["@@ -1 +1 @@", "-a", "+b"]),
	patch("src/store.ts", ["@@ -1 +1 @@", "-c", "+d", "@@ -9 +9 @@", "-e", "+f"]),
	patch("src/store.test.ts", ["@@ -1 +1 @@", "-t", "+u"]),
	{ path: "logo.png", patch: "" },
];
const [api, store1, store2, test, logo] = liveHunkIds(patches);

const chapter = (
	id: string,
	ordinal: number,
	hunkIds: ReadonlyArray<string | undefined>,
	kind: "core" | "tests" | "mechanical" = "core",
	validatedBy: ReadonlyArray<string | undefined> = [],
) =>
	new ReviewGuideChapter({
		id,
		ordinal,
		kind,
		title: id,
		summary: "",
		hunkIds: hunkIds as ReadonlyArray<string>,
		validatedBy: validatedBy as ReadonlyArray<string>,
		askHints: [],
		auto: kind !== "core",
	});

const labels = { newTitle: "New since guide", newSummary: "" };

describe("projectGuide", () => {
	it("orders files by chapter and collapses grouped files", () => {
		const view = projectGuide(
			[
				chapter("store", 0, [store1, store2], "core", [test]),
				chapter("api", 1, [api]),
				chapter("auto-tests", 2, [test], "tests"),
				chapter("auto-mechanical", 3, [logo], "mechanical"),
			],
			patches,
			labels,
		);
		expect(view.chapters.map((entry) => entry.files)).toEqual([
			["src/store.ts"],
			["src/api.ts"],
			["src/store.test.ts"],
			["logo.png"],
		]);
		expect(view.chapters.map((entry) => entry.number)).toEqual([
			1,
			2,
			null,
			null,
		]);
		expect(view.chapters[0]?.testFiles).toEqual(["src/store.test.ts"]);
		expect(view.chapters.some((entry) => entry.kind === "new")).toBe(false);
	});

	it("surfaces hunks written after the guide and marks changed chapters", () => {
		const view = projectGuide(
			[chapter("store", 0, [store1, "src/store.ts@gone"])],
			patches,
			labels,
		);
		expect(view.chapters[0]?.id).toBe(NEW_SINCE_GUIDE_ID);
		expect(view.chapters[0]?.files).toEqual([
			"src/api.ts",
			"src/store.ts",
			"src/store.test.ts",
			"logo.png",
		]);
		expect(view.chapters[1]?.changed).toBe(true);
		expect(view.chapters[0]?.hunkCount).toBe(4);
	});
});

describe("chapter review", () => {
	const fileHunks = new Map([
		["a.ts", ["a.ts@1", "a.ts@2"]],
		["b.ts", ["b.ts@1"]],
	]);
	const first = { hunkIds: ["a.ts@1", "b.ts@1"] };
	const second = { hunkIds: ["a.ts@2"] };

	it("reviews only the chapter's own hunks of a shared file", () => {
		const viewed = new Set<string>();
		const result = reviewChapter(first, true, {
			reviewedHunks: new Set(),
			fileHunks,
			isFileViewed: (path) => viewed.has(path),
		});
		expect(result.toggleFiles).toEqual(["b.ts"]);
		for (const path of result.toggleFiles) viewed.add(path);
		const isViewed = (path: string) => viewed.has(path);
		expect(isChapterReviewed(first, result.reviewedHunks, isViewed)).toBe(true);
		expect(isChapterReviewed(second, result.reviewedHunks, isViewed)).toBe(
			false,
		);
	});

	it("views a file once all of its hunks are reviewed", () => {
		const result = reviewChapter(second, true, {
			reviewedHunks: new Set(["a.ts@1", "b.ts@1"]),
			fileHunks,
			isFileViewed: (path) => path === "b.ts",
		});
		expect(result.toggleFiles).toEqual(["a.ts"]);
	});

	it("unchecking a file unreviews the chapters that share it", () => {
		const reviewed = withoutFileHunks(new Set(["a.ts@1", "b.ts@1"]), "a.ts");
		expect([...reviewed]).toEqual(["b.ts@1"]);
		expect(isChapterReviewed(first, reviewed, () => false)).toBe(false);
	});

	it("unchecking one chapter keeps the other reviewed", () => {
		const result = reviewChapter(second, false, {
			reviewedHunks: new Set(),
			fileHunks,
			isFileViewed: (path) => path === "a.ts",
		});
		expect(result.toggleFiles).toEqual(["a.ts"]);
		expect([...result.reviewedHunks]).toEqual(["a.ts@1"]);
	});
});
