import { describe, expect, it } from "vitest";

import {
	classifyReviewFile,
	detectMoves,
	extendHunksToScope,
	hunkIds,
	indentationScopeStart,
	isImportOnlyHunk,
	isMovedWholeHunk,
	isWhitespaceOnlyHunk,
	joinPatchHunks,
	reviewFingerprint,
	selectHunks,
	splitPatchHunks,
} from "../../src/review-outline.ts";

const patchOf = (path: string, hunks: ReadonlyArray<string>): string =>
	`${[
		`diff --git a/${path} b/${path}`,
		`--- a/${path}`,
		`+++ b/${path}`,
		...hunks,
	].join("\n")}\n`;

describe("splitPatchHunks", () => {
	it("round-trips a patch with several hunks", () => {
		const patch = patchOf("src/a.ts", [
			"@@ -1,2 +1,2 @@ export function a()",
			"-old",
			"+new",
			" keep",
			"@@ -10 +10,2 @@",
			" ctx",
			"+--- added banner",
		]);
		const split = splitPatchHunks(patch);
		expect(split.preamble).toHaveLength(3);
		expect(split.hunks.map((hunk) => hunk.newStart)).toEqual([1, 10]);
		expect(split.hunks[0]?.suffix).toBe(" export function a()");
		expect(split.hunks[1]?.lines).toContain("+--- added banner");
		expect(joinPatchHunks(split)).toBe(
			patch.replace("@@ -10 +10,2 @@", "@@ -10,1 +10,2 @@"),
		);
	});
});

describe("hunkIds", () => {
	it("is stable when a hunk shifts within its file", () => {
		const before = splitPatchHunks(
			patchOf("a.ts", ["@@ -5,2 +5,2 @@", " ctx", "-x = 1", "+x = 2"]),
		);
		const after = splitPatchHunks(
			patchOf("a.ts", ["@@ -40,2 +42,2 @@", " other", "-x = 1", "+x = 2  "]),
		);
		expect(hunkIds("a.ts", before.hunks)).toEqual(hunkIds("a.ts", after.hunks));
	});

	it("tells identical hunks apart by order", () => {
		const split = splitPatchHunks(
			patchOf("a.ts", ["@@ -1 +1 @@", "-a", "+b", "@@ -9 +9 @@", "-a", "+b"]),
		);
		const [first, second] = hunkIds("a.ts", split.hunks);
		expect(second).toBe(`${first}#1`);
	});

	it("keeps the file fingerprint used by viewed state", () => {
		expect(reviewFingerprint("+first\n")).not.toBe(
			reviewFingerprint("+second\n"),
		);
		expect(reviewFingerprint("abc")).toMatch(/^3:[0-9a-z]+$/);
	});
});

describe("classifyReviewFile", () => {
	it.each([
		["src/review.test.ts", "tests"],
		["apps/server/test/unit/a.ts", "tests"],
		["pkg/__snapshots__/x.snap", "tests"],
		["internal/store_test.go", "tests"],
		["bun.lock", "generated"],
		["packages/agents/src/drivers/codex/generated/Auth.ts", "generated"],
		["web/app.min.js", "generated"],
		["src/review-outline.ts", "core"],
		["src/testing-library.ts", "core"],
	] as const)("%s is %s", (path, kind) => {
		expect(classifyReviewFile(path)).toBe(kind);
	});
});

describe("mechanical hunks", () => {
	it("recognizes re-indentation", () => {
		const [hunk] = splitPatchHunks(
			patchOf("a.ts", [
				"@@ -1,2 +1,2 @@",
				"-\tif (x) {",
				"-\t\ty();",
				"+  if (x) {",
				"+    y();",
			]),
		).hunks;
		expect(hunk && isWhitespaceOnlyHunk(hunk)).toBe(true);
	});

	it("recognizes re-wrapping", () => {
		const [hunk] = splitPatchHunks(
			patchOf("a.ts", [
				"@@ -1 +1,3 @@",
				"-call(a, b);",
				"+call(",
				"+  a,",
				"+  b);",
			]),
		).hunks;
		expect(hunk && isWhitespaceOnlyHunk(hunk)).toBe(true);
	});

	it("does not call reordered lines whitespace-only", () => {
		const [hunk] = splitPatchHunks(
			patchOf("a.ts", ["@@ -1,2 +1,2 @@", "-a();", "-b();", "+b();", "+a();"]),
		).hunks;
		expect(hunk && isWhitespaceOnlyHunk(hunk)).toBe(false);
	});

	it("keeps whitespace inside strings meaningful", () => {
		const [hunk] = splitPatchHunks(
			patchOf("a.ts", ["@@ -1 +1 @@", '-send("a  b");', '+send("a b");']),
		).hunks;
		expect(hunk && isWhitespaceOnlyHunk(hunk)).toBe(false);
	});

	it("does not call a real edit whitespace-only", () => {
		const [hunk] = splitPatchHunks(
			patchOf("a.ts", ["@@ -1 +1 @@", "-a()", "+b()"]),
		).hunks;
		expect(hunk && isWhitespaceOnlyHunk(hunk)).toBe(false);
	});

	it("recognizes import-only edits", () => {
		const [hunk] = splitPatchHunks(
			patchOf("a.ts", [
				"@@ -1,3 +1,4 @@",
				" import {",
				"-\ta,",
				"+\ta,",
				"+\tb,",
				'-} from "./x";',
				'+} from "./y";',
				'+import { c } from "./c";',
			]),
		).hunks;
		expect(hunk && isImportOnlyHunk(hunk)).toBe(true);
	});

	it("does not call bare identifiers imports without an import line", () => {
		const [hunk] = splitPatchHunks(
			patchOf("a.ts", ["@@ -1 +1 @@", "-alpha,", "+beta,"]),
		).hunks;
		expect(hunk && isImportOnlyHunk(hunk)).toBe(false);
	});
});

describe("indentationScopeStart", () => {
	const source = [
		"class Store:",
		"    def load(self, key):",
		"        if key:",
		"            value = self.read(key)",
		"            return value",
		"        return None",
	];

	it("finds the enclosing definition, not the nearest block", () => {
		expect(indentationScopeStart(source, 4)).toBe(2);
	});

	it("is null at top level", () => {
		expect(indentationScopeStart(source, 1)).toBeNull();
	});

	it("skips closers when climbing", () => {
		const code = [
			"function run() {",
			"  if (a) {",
			"    one();",
			"  } else {",
			"    two();",
			"  }",
			"}",
		];
		expect(indentationScopeStart(code, 5)).toBe(1);
	});

	it("respects the climb limit", () => {
		const code = ["def f():", ...Array.from({ length: 40 }, () => "    x = 1")];
		expect(indentationScopeStart(code, 41, 10)).toBeNull();
	});
});

describe("extendHunksToScope", () => {
	const file = [
		"export function total(items) {", // 1
		"  let sum = 0;",
		"  for (const item of items) {",
		"    const price = item.price;",
		"    const qty = item.qty;",
		"    sum += price * qty;", // 6
		"  }",
		"  return sum;",
		"}",
	];

	it("starts a hunk at its enclosing function", () => {
		const patch = patchOf("a.ts", [
			"@@ -4,3 +4,3 @@",
			"     const price = item.price;",
			"     const qty = item.qty;",
			"-    sum += price;",
			"+    sum += price * qty;",
		]);
		const extended = extendHunksToScope(patch, file, () => 1);
		const [hunk] = splitPatchHunks(extended).hunks;
		expect(hunk?.newStart).toBe(1);
		expect(hunk?.oldStart).toBe(1);
		expect(hunk?.newLines).toBe(6);
		expect(hunk?.lines[0]).toBe(" export function total(items) {");
	});

	it("never extends past the hunk above or beyond the limit", () => {
		const patch = patchOf("a.ts", [
			"@@ -1,1 +1,1 @@",
			"-export function total(list) {",
			"+export function total(items) {",
			"@@ -6,1 +6,1 @@",
			"-    sum += price;",
			"+    sum += price * qty;",
		]);
		const extended = extendHunksToScope(patch, file, () => 1);
		const [, second] = splitPatchHunks(extended).hunks;
		expect(second?.newStart).toBe(2);
		expect(extendHunksToScope(patch, file, () => 1, 2)).toBe(
			extendHunksToScope(
				patchOf("a.ts", [
					"@@ -1,1 +1,1 @@",
					"-export function total(list) {",
					"+export function total(items) {",
					"@@ -6,1 +6,1 @@",
					"-    sum += price;",
					"+    sum += price * qty;",
				]),
				file,
				() => null,
			),
		);
	});

	it("leaves a hunk alone when the file is not its new side", () => {
		const patch = patchOf("a.ts", [
			"@@ -6,1 +6,1 @@",
			"-    sum += price;",
			"+    sum += price * 2;",
		]);
		expect(extendHunksToScope(patch, file, () => 1)).toBe(patch);
	});

	it("leaves the patch untouched when no scope is found", () => {
		const patch = patchOf("a.ts", ["@@ -6 +6 @@", "-a", "+b"]);
		expect(extendHunksToScope(patch, file, () => null)).toBe(patch);
	});
});

describe("detectMoves", () => {
	const block = [
		"export const launchEditor = (path: string) => {",
		"  const editor = process.env.EDITOR ?? 'code';",
		"  const args = [path, '--wait'];",
		"  const child = spawn(editor, args);",
		"  child.on('exit', (code) => log(code));",
		"  return child;",
		"};",
	];

	it("links a block cut from one file and pasted in another", () => {
		const from = splitPatchHunks(
			patchOf("src/local-diffs.tsx", [
				"@@ -10,8 +10,1 @@",
				" keep();",
				...block.map((line) => `-${line}`),
			]),
		).hunks;
		const to = splitPatchHunks(
			patchOf("src/editor-launch.ts", [
				"@@ -1,0 +1,7 @@",
				...block.map((line) => `+  ${line}`),
			]),
		).hunks;
		const moves = detectMoves([
			{ path: "src/local-diffs.tsx", hunks: from },
			{ path: "src/editor-launch.ts", hunks: to },
		]);
		expect(moves).toEqual([
			{
				from: { path: "src/local-diffs.tsx", startLine: 11, endLine: 17 },
				to: { path: "src/editor-launch.ts", startLine: 1, endLine: 7 },
				lineCount: 7,
			},
		]);
		expect(
			from[0] && isMovedWholeHunk("src/local-diffs.tsx", from[0], moves),
		).toBe(true);
	});

	it("ignores short blocks and in-place edits", () => {
		const hunks = splitPatchHunks(
			patchOf("a.ts", [
				"@@ -1,7 +1,7 @@",
				...block.map((line) => `-${line}`),
				...block.map((line) => `+${line}`),
			]),
		).hunks;
		expect(detectMoves([{ path: "a.ts", hunks }])).toEqual([]);
		const short = splitPatchHunks(
			patchOf("b.ts", [
				"@@ -1,2 +1,0 @@",
				...block.slice(0, 2).map((l) => `-${l}`),
			]),
		).hunks;
		const shortTo = splitPatchHunks(
			patchOf("c.ts", [
				"@@ -0,0 +1,2 @@",
				...block.slice(0, 2).map((l) => `+${l}`),
			]),
		).hunks;
		expect(
			detectMoves([
				{ path: "b.ts", hunks: short },
				{ path: "c.ts", hunks: shortTo },
			]),
		).toEqual([]);
	});

	it("skips huge changes", () => {
		const hunks = splitPatchHunks(
			patchOf("a.ts", ["@@ -1,7 +1,0 @@", ...block.map((line) => `-${line}`)]),
		).hunks;
		expect(
			detectMoves([{ path: "a.ts", hunks }], { maxChangedLines: 3 }),
		).toEqual([]);
	});
});

describe("selectHunks", () => {
	const patch = patchOf("a.ts", [
		"@@ -1 +1 @@",
		"-a",
		"+b",
		"@@ -9 +9 @@",
		"-c",
		"+d",
	]);
	const [first, second] = hunkIds("a.ts", splitPatchHunks(patch).hunks);

	it("keeps only the wanted hunks", () => {
		const selected = selectHunks("a.ts", patch, new Set([second ?? ""]));
		expect(selected).not.toBeNull();
		expect(
			splitPatchHunks(selected ?? "").hunks.map((h) => h.newStart),
		).toEqual([9]);
	});

	it("returns the patch unchanged when every hunk is wanted, null when none", () => {
		expect(
			selectHunks("a.ts", patch, new Set([first ?? "", second ?? ""])),
		).toBe(patch);
		expect(selectHunks("a.ts", patch, new Set())).toBeNull();
	});
});
