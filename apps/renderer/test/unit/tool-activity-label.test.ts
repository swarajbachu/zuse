import { formatSentenceList, message } from "@zuse/i18n";
import { describe, expect, it } from "vitest";
import {
	toolActivityLabel,
	toolActivitySummary,
} from "../../src/lib/tool-activity-label.ts";
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
		expect(toolActivityLabel(tool, message)).toBe(label);
	});
	it("interpolates unfamiliar tool names as text", () => {
		expect(toolActivityLabel("custom_tool", message)).toBe(
			"Using custom_tool…",
		);
	});
	it("summarizes settled calls by activity in order of first appearance", () => {
		expect(
			toolActivitySummary(
				["Bash", "Read", "Shell", "Read", "Bash"],
				message,
				formatSentenceList,
			),
		).toBe("Ran 3 commands and read 2 files");
		expect(
			toolActivitySummary(
				["Edit", "custom_tool", "Grep"],
				message,
				formatSentenceList,
			),
		).toBe("Made 1 edit, used 1 tool, and ran 1 search");
	});
	it("falls back to a neutral label when there are no tool calls", () => {
		expect(toolActivitySummary([], message, formatSentenceList)).toBe(
			"Activity",
		);
	});
});
