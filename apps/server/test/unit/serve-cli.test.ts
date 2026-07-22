import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseServeOptions } from "../../src/bin.ts";

describe("zuse serve CLI", () => {
	it("parses explicit host, port, data, static, open, and auth options", async () => {
		const staticDir = await mkdtemp(join(tmpdir(), "zuse-cli-client-"));
		const options = parseServeOptions(
			[
				"serve",
				"--host",
				"0.0.0.0",
				"--port",
				"4912",
				"--data-dir",
				"/tmp/zuse-data",
				"--static-dir",
				staticDir,
				"--open",
				"--auth",
				"protected",
			],
			{},
		);
		expect(options).toMatchObject({
			host: "0.0.0.0",
			port: 4912,
			dataDir: "/tmp/zuse-data",
			staticDir,
			open: true,
			policy: "protected",
			pairing: true,
		});
	});

	it("protects non-loopback binds automatically", () => {
		const options = parseServeOptions(["serve", "--host", "192.168.1.20"], {
			HOME: "/tmp/home",
		});
		expect(options.policy).toBe("protected");
	});

	it("supports explicitly disabling pairing for managed deployments", () => {
		const options = parseServeOptions(["serve", "--no-pairing"], {
			HOME: "/tmp/home",
		});
		expect(options.pairing).toBe(false);
	});

	it("refuses explicitly unauthenticated non-loopback binds", () => {
		expect(() =>
			parseServeOptions(["serve", "--host", "0.0.0.0", "--auth", "local"], {}),
		).toThrow(/Refusing unauthenticated access/u);
	});

	it("rejects invalid ports and commands", () => {
		expect(() => parseServeOptions(["serve", "--port", "70000"], {})).toThrow(
			/--port/u,
		);
		expect(() => parseServeOptions(["unknown"], {})).toThrow(
			/Unknown command/u,
		);
	});
});
