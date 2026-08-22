import { describe, expect, it } from "vitest";

import { parseServeCommand } from "../../src/serve/command.ts";

const defaults = {
	json: false,
	foreground: false,
	force: false,
	dataDir: undefined,
	sshManaged: false,
	tailscale: false,
	noAccount: false,
	lan: false,
	host: undefined,
	port: undefined,
} as const;

describe("zuse serve management commands", () => {
	it("starts serving when no management command is provided", () => {
		expect(parseServeCommand(["serve"])).toEqual({
			...defaults,
			action: "start",
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
			...defaults,
			action: "status",
			json: true,
		});
	});

	it("supports explicit foreground and forced update modes", () => {
		expect(parseServeCommand(["serve", "--foreground"])).toEqual({
			...defaults,
			action: "start",
			foreground: true,
		});
		expect(parseServeCommand(["serve", "update", "--force"])).toEqual({
			...defaults,
			action: "update",
			force: true,
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
			...defaults,
			action: "start",
			foreground: true,
			dataDir: "/tmp/zuse-serve",
		});
	});

	it("parses SSH-managed start mode", () => {
		expect(parseServeCommand(["serve", "start", "--ssh-managed"])).toEqual({
			...defaults,
			action: "start",
			sshManaged: true,
		});
	});

	it("parses Tailnet sharing mode", () => {
		expect(parseServeCommand(["serve", "start", "--tailscale"])).toEqual({
			...defaults,
			action: "start",
			tailscale: true,
		});
		expect(() =>
			parseServeCommand(["serve", "start", "--tailscale", "--ssh-managed"]),
		).toThrow(/cannot be used together/u);
	});

	it("parses LAN, host, port, and account opt-out flags", () => {
		expect(parseServeCommand(["serve", "start", "--lan"])).toEqual({
			...defaults,
			action: "start",
			lan: true,
			host: "0.0.0.0",
		});
		expect(
			parseServeCommand([
				"serve",
				"start",
				"--host",
				"192.168.1.50",
				"--port",
				"5000",
			]),
		).toEqual({
			...defaults,
			action: "start",
			host: "192.168.1.50",
			port: 5000,
		});
		expect(parseServeCommand(["serve", "start", "--no-account"])).toEqual({
			...defaults,
			action: "start",
			noAccount: true,
		});
		expect(() => parseServeCommand(["serve", "start", "--port", "0"])).toThrow(
			/--port requires a port number/u,
		);
		expect(() =>
			parseServeCommand(["serve", "start", "--lan", "--host", "10.0.0.1"]),
		).toThrow(/either --lan or --host/u);
		expect(() =>
			parseServeCommand(["serve", "start", "--ssh-managed", "--lan"]),
		).toThrow(/loopback-only/u);
		expect(() => parseServeCommand(["serve", "status", "--lan"])).toThrow(
			/only valid when starting/u,
		);
		expect(() =>
			parseServeCommand(["serve", "status", "--port", "5000"]),
		).toThrow(/only valid when starting/u);
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
