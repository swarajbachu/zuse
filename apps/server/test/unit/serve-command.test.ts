import { describe, expect, it } from "vitest";

import { parseServeCommand } from "../../src/serve/command.ts";

describe("zuse serve management commands", () => {
	it("starts serving when no management command is provided", () => {
		expect(parseServeCommand(["serve"])).toEqual({
			action: "start",
			json: false,
			foreground: false,
			force: false,
			dataDir: undefined,
			sshManaged: false,
			tailscale: false,
		});
	});

	it("supports explicit start, help, and version commands", () => {
		expect(parseServeCommand(["serve", "start"])).toMatchObject({
			action: "start",
		});
		expect(parseServeCommand(["serve", "help"])).toMatchObject({
			action: "help",
		});
		expect(parseServeCommand(["serve", "--help"])).toMatchObject({
			action: "help",
		});
		expect(parseServeCommand(["serve", "--version"])).toMatchObject({
			action: "version",
		});
	});

	it("parses status JSON output", () => {
		expect(parseServeCommand(["serve", "status", "--json"])).toEqual({
			action: "status",
			json: true,
			foreground: false,
			force: false,
			dataDir: undefined,
			sshManaged: false,
			tailscale: false,
		});
	});

	it("supports explicit foreground and forced update modes", () => {
		expect(parseServeCommand(["serve", "--foreground"])).toEqual({
			action: "start",
			json: false,
			foreground: true,
			force: false,
			dataDir: undefined,
			sshManaged: false,
			tailscale: false,
		});
		expect(parseServeCommand(["serve", "update", "--force"])).toEqual({
			action: "update",
			json: false,
			foreground: false,
			force: true,
			dataDir: undefined,
			sshManaged: false,
			tailscale: false,
		});
	});

	it("parses the data directory used by durable service definitions", () => {
		expect(
			parseServeCommand([
				"serve",
				"--foreground",
				"--data-dir",
				"/tmp/zuse-serve",
			]),
		).toEqual({
			action: "start",
			json: false,
			foreground: true,
			force: false,
			dataDir: "/tmp/zuse-serve",
			sshManaged: false,
			tailscale: false,
		});
	});

	it("parses SSH-managed start mode", () => {
		expect(parseServeCommand(["serve", "start", "--ssh-managed"])).toEqual({
			action: "start",
			json: false,
			foreground: false,
			force: false,
			dataDir: undefined,
			sshManaged: true,
			tailscale: false,
		});
	});

	it("parses Tailnet sharing mode", () => {
		expect(parseServeCommand(["serve", "start", "--tailscale"])).toEqual({
			action: "start",
			json: false,
			foreground: false,
			force: false,
			dataDir: undefined,
			sshManaged: false,
			tailscale: true,
		});
		expect(() =>
			parseServeCommand(["serve", "start", "--tailscale", "--ssh-managed"]),
		).toThrow(/cannot be used together/u);
	});

	it("rejects unsupported commands and misplaced flags", () => {
		expect(() => parseServeCommand(["serve", "restart"])).toThrow(
			/Unknown zuse serve command/u,
		);
		expect(() => parseServeCommand(["serve", "status", "--force"])).toThrow(
			/--force is only valid with update/u,
		);
		expect(() => parseServeCommand(["serve", "--data-dir"])).toThrow(
			/--data-dir requires a value/u,
		);
		expect(() => parseServeCommand(["serve", "help", "--json"])).toThrow(
			/--json is only valid with status/u,
		);
		expect(() =>
			parseServeCommand(["serve", "status", "--ssh-managed"]),
		).toThrow(/--ssh-managed is only valid when starting/u);
	});
});
