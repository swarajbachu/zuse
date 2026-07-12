import { describe, expect, test } from "vitest";

import { canonicalizeToolInput } from "../../../src/kernel/tool-input.js";

describe("canonicalizeToolInput", () => {
	test("normalizes path aliases and recursively sorts object keys", () => {
		expect(
			canonicalizeToolInput({
				z: [{ target_file: "a.ts", b: 2, a: 1 }],
				filePath: "root.ts",
			}),
		).toEqual({
			file_path: "root.ts",
			z: [{ a: 1, b: 2, file_path: "a.ts" }],
		});
	});
});
