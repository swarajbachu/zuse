import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { scanFollowUps } from "../follow-ups.ts";

it("extracts tags, paths, line numbers and surrounding code", () => {
	const results = scanFollowUps(
		readFileSync(new URL("../fixtures/example.txt", import.meta.url), "utf8"),
		"src/checkout.ts",
	);
	expect(results).toHaveLength(2);
	expect(results[0]?.title).toBe("TODO: support partial refunds");
	expect(results[0]?.subtitle).toBe("src/checkout.ts:2");
	expect(results[0]?.text).toContain("3:   return false;");
});
it("skips generated files and ordinary prose", () => {
	expect(scanFollowUps("// TODO: fix", "app.min.js")).toEqual([]);
	expect(scanFollowUps("TODO list", "README.md")).toEqual([]);
	expect(scanFollowUps("", "empty.ts")).toEqual([]);
});
