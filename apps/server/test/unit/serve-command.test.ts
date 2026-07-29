import { describe, expect, it } from "vitest";

import { parseServeCommand } from "../../src/serve/command.ts";

describe("zuse serve management commands", () => {
	it("starts serving when no management command is provided", () => {
		expect(parseServeCommand(["serve"])).toEqual({
			action: "start",
			json: false,
			foreground: false,
			force: false,
		});
	});

	it("parses status JSON output", () => {
		expect(parseServeCommand(["serve", "status", "--json"])).toEqual({
			action: "status",
			json: true,
			foreground: false,
			force: false,
		});
	});

	it("supports explicit foreground and forced update modes", () => {
		expect(parseServeCommand(["serve", "--foreground"])).toEqual({
			action: "start",
			json: false,
			foreground: true,
			force: false,
		});
		expect(parseServeCommand(["serve", "update", "--force"])).toEqual({
			action: "update",
			json: false,
			foreground: false,
			force: true,
		});
	});

	it("rejects unsupported commands and misplaced flags", () => {
		expect(() => parseServeCommand(["serve", "restart"])).toThrow(
			/Unknown zuse serve command/u,
		);
		expect(() => parseServeCommand(["serve", "status", "--force"])).toThrow(
			/--force is only valid with update/u,
		);
	});
});
