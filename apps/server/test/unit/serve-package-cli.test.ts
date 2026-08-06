import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
	activateServeRuntimeUpdate,
	latestPairingLink,
	removeServeRuntime,
	resolveServeDataDir,
	runServePackageCli,
	SERVE_HELP,
} from "../../src/serve/package-cli.ts";

describe("serve data directory", () => {
	it("uses the stable desktop profile on macOS", () => {
		expect(
			resolveServeDataDir({}, undefined, {
				platform: "darwin",
				homeDir: "/Users/dev",
			}),
		).toBe("/Users/dev/Library/Application Support/Zuse Alpha");
	});

	it("preserves explicit data-directory overrides", () => {
		expect(
			resolveServeDataDir(
				{ ZUSE_USER_DATA: "/tmp/from-env" },
				"/tmp/explicit",
				{ platform: "darwin", homeDir: "/Users/dev" },
			),
		).toBe("/tmp/explicit");
	});
});

describe("Serve package metadata commands", () => {
	it("selects the newest pairing link from service output", () => {
		expect(
			latestPairingLink(
				"QR: zuse:///connect/pair?old\nready\nQR: zuse:///connect/pair?new#token=zp_new\n",
			),
		).toBe("zuse:///connect/pair?new#token=zp_new");
	});

	it("prints help without starting or mutating the runtime environment", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const env: NodeJS.ProcessEnv = {};

		await runServePackageCli(["--help"], env, { packageVersion: "1.2.3" });

		expect(log).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledWith(SERVE_HELP);
		expect(env).toEqual({});
		log.mockRestore();
	});

	it("prints the packaged version without starting the service", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

		await runServePackageCli(["--version"], {}, { packageVersion: "1.2.3" });

		expect(log).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledWith("1.2.3");
		log.mockRestore();
	});

	it("restores the previous runtime when update readiness fails", async () => {
		const installed: string[] = [];
		const readinessTimeouts: Array<number | undefined> = [];
		const persist = vi.fn();

		await expect(
			activateServeRuntimeUpdate({
				dataDir: "/srv/zuse",
				version: "2.0.0",
				executable: "/runtime/2/bin.mjs",
				previous: {
					version: "1.0.0",
					executable: "/runtime/1/bin.mjs",
				},
				installService: async (executable) => {
					installed.push(executable);
				},
				waitUntilReachable: async (timeoutMs) => {
					readinessTimeouts.push(timeoutMs);
					return timeoutMs === 20_000;
				},
				persist,
			}),
		).rejects.toThrow(/restored the previous runtime/u);
		expect(installed).toEqual(["/runtime/2/bin.mjs", "/runtime/1/bin.mjs"]);
		expect(readinessTimeouts).toEqual([undefined, 20_000]);
		expect(persist).not.toHaveBeenCalled();
	});

	it("removes only the managed runtime during uninstall", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "zuse-serve-uninstall-"));
		const workspace = join(dataDir, "workspaces", "project", "README.md");
		await mkdir(join(dataDir, "runtime"), { recursive: true });
		await writeFile(join(dataDir, "runtime", "active.json"), "{}");
		await mkdir(join(dataDir, "workspaces", "project"), { recursive: true });
		await writeFile(workspace, "preserved");

		await removeServeRuntime(dataDir);

		await expect(access(join(dataDir, "runtime"))).rejects.toThrow();
		await expect(access(workspace)).resolves.toBeUndefined();
		await rm(dataDir, { recursive: true, force: true });
	});
});
