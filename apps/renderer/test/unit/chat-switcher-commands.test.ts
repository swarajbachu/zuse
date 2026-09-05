import { describe, expect, it } from "vitest";

import {
	commandRowsForQuery,
	commandSearchQuery,
} from "../../src/lib/chat-switcher-commands.ts";
import { APPLICATION_COMMANDS } from "../../src/lib/commands.ts";
import {
	COMMAND_META,
	COMMANDS_IN_ORDER,
} from "../../src/lib/default-keybindings.ts";

describe("chat switcher command mode", () => {
	it("enters command mode only when the trimmed query starts with >", () => {
		expect(commandSearchQuery("chat")).toBeNull();
		expect(commandSearchQuery("chat > settings")).toBeNull();
		expect(commandSearchQuery("  > settings ")).toBe("settings");
	});

	it("projects application commands in canonical order and excludes itself", () => {
		const expected = COMMANDS_IN_ORDER.filter(
			(command) =>
				APPLICATION_COMMANDS.has(command) && command !== "open-chat-switcher",
		);
		const rows = commandRowsForQuery(">");

		expect(rows.map((row) => row.command)).toEqual(expected);
		expect(rows.map((row) => row.command)).not.toContain("open-chat-switcher");
		expect(rows.map((row) => row.command)).not.toContain("composer.submit");
		expect(rows.map((row) => row.command)).not.toContain("editor.save");
	});

	it("copies labels and descriptions from the shared command metadata", () => {
		const row = commandRowsForQuery(">").find(
			(candidate) => candidate.command === "new-chat",
		);

		expect(row).toMatchObject(COMMAND_META["new-chat"]);
	});

	it("searches command labels, descriptions, and groups", () => {
		expect(commandRowsForQuery(">terminal")[0]?.command).toBe(
			"toggle-terminal",
		);
		expect(
			commandRowsForQuery(">pick folder").map((row) => row.command),
		).toContain("open-project");
		expect(commandRowsForQuery(">application").length).toBeGreaterThan(1);
	});

	it("returns no command rows in chat mode", () => {
		expect(commandRowsForQuery("settings")).toEqual([]);
	});
});
