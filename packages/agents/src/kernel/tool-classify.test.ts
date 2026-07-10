import { describe, expect, test } from "vitest";

import { classifyTool } from "./tool-classify.js";

describe("classifyTool", () => {
	test.each([
		["Read", "read"],
		["Grep", "read"],
		["Edit", "edit"],
		["NotebookEdit", "edit"],
		["Bash", "execute"],
		["shell", "execute"],
		["WebSearch", "network"],
		["Agent", "delegate"],
		["ExitPlanMode", "exit-plan"],
		["custom_mcp_tool", "other"],
	] as const)("classifies %s as %s", (tool, category) => {
		expect(classifyTool(tool)).toBe(category);
	});

	test("allows a driver capability descriptor to override native names", () => {
		expect(classifyTool("apply_patch", { apply_patch: "edit" })).toBe("edit");
	});
});
