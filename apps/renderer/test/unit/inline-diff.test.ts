import { describe, expect, it } from "vitest";

import { isPatchDiffRenderable } from "../../src/lib/patch-diff.ts";

describe("inline diff patch rendering", () => {
	it("accepts unified hunk patches", () => {
		expect(
			isPatchDiffRenderable(`@@ -1,2 +1,2 @@
-old
+new
`),
		).toBe(true);
	});

	it("accepts git diff patches", () => {
		expect(
			isPatchDiffRenderable(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
+new
`),
		).toBe(true);
	});

	it("keeps apply_patch payloads out of PatchDiff", () => {
		expect(
			isPatchDiffRenderable(`*** Begin Patch
*** Update File: a.txt
@@
-old
+new
*** End Patch
`),
		).toBe(false);
	});
});
