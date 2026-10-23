import {
	type FolderId,
	GitDiffResult,
	GitReviewFileContents,
	GitReviewPatch,
} from "@zuse/contracts";
import type { GitService } from "@zuse/git/git-service";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
	extendReviewPatch,
	fileScopesFrom,
	innermostSymbol,
} from "../../src/review/scope-context.ts";

const source = [
	"export class Cart {", // 1
	"  total(items) {", // 2
	"    let sum = 0;",
	"    for (const item of items) {",
	"      const price = item.price;",
	"      const qty = item.qty;",
	"      sum += price * qty;", // 7
	"    }",
	"    return sum;",
	"  }",
	"}",
].join("\n");

const symbols = [
	{ name: "Cart", kind: "class", startLine: 1, endLine: 11 },
	{ name: "total", kind: "method", startLine: 2, endLine: 10 },
];

const patchText = [
	"diff --git a/cart.ts b/cart.ts",
	"--- a/cart.ts",
	"+++ b/cart.ts",
	"@@ -5,3 +5,3 @@",
	"       const price = item.price;",
	"       const qty = item.qty;",
	"-      sum += price;",
	"+      sum += price * qty;",
	"",
].join("\n");

const reviewPatch = (mode: "worktree" | "deleted" = "worktree") =>
	GitReviewPatch.make({
		path: "cart.ts",
		error: null,
		result: GitDiffResult.make({
			mode,
			patch: patchText,
			truncated: false,
			bytes: patchText.length,
		}),
	});

const fakeGit = (newContent: string | null) =>
	({
		reviewFileContents: () =>
			Effect.succeed(
				GitReviewFileContents.make({
					oldContent: null,
					newContent,
					mtime: "1",
				}),
			),
	}) as unknown as GitService["Service"];

describe("scope context", () => {
	it("picks the innermost enclosing symbol", () => {
		expect(innermostSymbol(symbols, 7)?.name).toBe("total");
		expect(innermostSymbol(symbols, 1)?.name).toBe("Cart");
		expect(innermostSymbol(symbols, 20)).toBeNull();
	});

	it("starts a scope at the symbol, falling back to indentation", () => {
		expect(fileScopesFrom(source, symbols).startOf(7)).toBe(2);
		expect(fileScopesFrom(source, []).startOf(7)).toBe(2);
	});

	it("extends a working-tree patch to its function", async () => {
		const extended = await Effect.runPromise(
			extendReviewPatch(
				fakeGit(source),
				"folder" as FolderId,
				null,
				"branch",
				reviewPatch(),
			),
		);
		expect(extended.result.patch).toContain("@@ -2,6 +2,6 @@");
		expect(extended.result.patch).toContain("   total(items) {");
		expect(extended.result.bytes).toBe(extended.result.patch.length);
	});

	it("leaves staged, deleted, and unreadable patches as git produced them", async () => {
		const original = reviewPatch();
		const staged = await Effect.runPromise(
			extendReviewPatch(
				fakeGit(source),
				"f" as FolderId,
				null,
				"staged",
				original,
			),
		);
		expect(staged).toBe(original);
		const deleted = reviewPatch("deleted");
		expect(
			await Effect.runPromise(
				extendReviewPatch(
					fakeGit(source),
					"f" as FolderId,
					null,
					"branch",
					deleted,
				),
			),
		).toBe(deleted);
		expect(
			await Effect.runPromise(
				extendReviewPatch(
					fakeGit(null),
					"f" as FolderId,
					null,
					"branch",
					original,
				),
			),
		).toBe(original);
		const failing = {
			reviewFileContents: () => Effect.fail(new Error("gone")),
		} as unknown as GitService["Service"];
		expect(
			await Effect.runPromise(
				extendReviewPatch(failing, "f" as FolderId, null, "branch", original),
			),
		).toBe(original);
	});
});
