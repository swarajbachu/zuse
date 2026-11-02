import { message } from "@zuse/i18n";
import { describe, expect, it } from "vitest";
import { toolActivityLabel } from "../../src/lib/tool-activity-label.ts";
import "@zuse/i18n/english/chat";

describe("compact tool activity", () => {
	it.each([
		["Edit", "Editing files…"],
		["MultiEdit", "Editing files…"],
		["WriteFile", "Writing files…"],
		["Bash", "Running Bash…"],
		["Shell", "Running command…"],
		["mcp__zuse__local_command_execute", "Running command…"],
		["Read", "Reading files…"],
		["Grep", "Searching files…"],
	])("labels %s without constructing a detail view", (tool, label) => {
		expect(toolActivityLabel(tool, true, message)).toBe(label);
	});
	it("uses a completed label without pretending a settled call is still running", () => {
		expect(toolActivityLabel("Edit", false, message)).toBe(
			"Last activity: Edit",
		);
	});
	it("interpolates unfamiliar tool names as text", () => {
		expect(toolActivityLabel("custom_tool", true, message)).toBe(
			"Using custom_tool…",
		);
	});
});
