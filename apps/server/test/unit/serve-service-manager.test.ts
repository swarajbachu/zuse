import { describe, expect, it, vi } from "vitest";

import {
	type ServeServicePaths,
	startServeService,
	stopServeService,
} from "../../src/serve/service-manager.ts";

const paths: ServeServicePaths = {
	platform: "darwin",
	definitionPath: "/Users/dev/Library/LaunchAgents/sh.zuse.serve.plist",
	dataDir: "/Users/dev/.local/share/zuse",
	logDir: "/Users/dev/.local/share/zuse/logs",
};

describe("Zuse Serve service lifecycle", () => {
	it("unloads a stopped macOS service and bootstraps it again on start", async () => {
		const commands: Array<readonly [string, ReadonlyArray<string>]> = [];
		const run = vi.fn(
			async (executable: string, args: ReadonlyArray<string>) => {
				commands.push([executable, args]);
				return { stdout: "", stderr: "" };
			},
		);
		const target = `gui/${process.getuid?.()}`;

		await stopServeService(paths, run);
		await startServeService(paths, run);

		expect(commands).toEqual([
			["launchctl", ["disable", `${target}/sh.zuse.serve`]],
			[
				"launchctl",
				[
					"bootout",
					target,
					"/Users/dev/Library/LaunchAgents/sh.zuse.serve.plist",
				],
			],
			["launchctl", ["enable", `${target}/sh.zuse.serve`]],
			[
				"launchctl",
				[
					"bootstrap",
					target,
					"/Users/dev/Library/LaunchAgents/sh.zuse.serve.plist",
				],
			],
			["launchctl", ["kickstart", "-k", `${target}/sh.zuse.serve`]],
		]);
	});

	it("treats an already-unloaded macOS service as stopped", async () => {
		const missingService = Object.assign(new Error("service not found"), {
			code: 113,
			stderr:
				'Could not find service "sh.zuse.serve" in domain for user gui: 501',
		});
		const run = vi.fn(
			async (_executable: string, args: ReadonlyArray<string>) => {
				if (args[0] === "bootout") throw new Error("bootout failed");
				if (args[0] === "print") throw missingService;
				return { stdout: "", stderr: "" };
			},
		);

		await expect(stopServeService(paths, run)).resolves.toBeUndefined();
	});

	it("reports a macOS unload failure while the service remains loaded", async () => {
		const bootoutFailure = new Error("bootout failed");
		const run = vi.fn(
			async (_executable: string, args: ReadonlyArray<string>) => {
				if (args[0] === "bootout") throw bootoutFailure;
				return { stdout: "", stderr: "" };
			},
		);

		await expect(stopServeService(paths, run)).rejects.toBe(bootoutFailure);
	});

	it("reports a macOS unload failure when service status is inconclusive", async () => {
		const bootoutFailure = new Error("bootout failed");
		const run = vi.fn(
			async (_executable: string, args: ReadonlyArray<string>) => {
				if (args[0] === "bootout") throw bootoutFailure;
				if (args[0] === "print") throw new Error("launchd unavailable");
				return { stdout: "", stderr: "" };
			},
		);

		await expect(stopServeService(paths, run)).rejects.toBe(bootoutFailure);
	});
});
