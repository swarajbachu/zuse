import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
	activateServeRuntimeUpdate,
	foregroundServeOptions,
	readServePairingBootstrap,
	removeServeRuntime,
	requiresServeAccountAuthorization,
	resolveServeDataDir,
	resolveServeStaticDir,
	runServePackageCli,
	SERVE_HELP,
	shouldAutoLinkForeground,
} from "../../src/serve/package-cli.ts";
import {
	readServeSettings,
	writeServeSettings,
} from "../../src/serve/settings.ts";

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
	it("honors container host and pairing environment in foreground mode", () => {
		expect(
			foregroundServeOptions(
				{
					ZUSE_HOST: "0.0.0.0",
					ZUSE_PORT: "47837",
					ZUSE_ENABLE_PAIRING: "0",
				},
				{
					sshManaged: false,
					dataDir: "/home/zuse/.zuse-data",
				},
			),
		).toMatchObject({
			host: "0.0.0.0",
			port: 47_837,
			pairing: false,
			policy: "protected",
		});
	});

	it("trusts proxy headers for a Tailscale Serve foreground route", () => {
		expect(
			foregroundServeOptions(
				{},
				{
					sshManaged: false,
					dataDir: "/home/zuse/.zuse-data",
				},
				"https://build.example.ts.net",
			),
		).toMatchObject({
			pairingPublicBaseUrl: "https://build.example.ts.net",
			trustProxy: true,
		});
	});

	it("requires account authorization unless explicitly opted out", () => {
		expect(
			requiresServeAccountAuthorization({ sshManaged: false, noAccount: true }),
		).toBe(false);
		expect(
			requiresServeAccountAuthorization({ sshManaged: true, noAccount: false }),
		).toBe(false);
		expect(
			requiresServeAccountAuthorization({
				sshManaged: false,
				noAccount: false,
			}),
		).toBe(true);
		expect(
			requiresServeAccountAuthorization({
				sshManaged: false,
				noAccount: false,
				cloudWorkspaceId: "workspace_123",
			}),
		).toBe(false);
	});

	it("does not auto-link a cloud workspace as a persistent computer", () => {
		expect(
			shouldAutoLinkForeground({
				sshManaged: false,
				noAccount: false,
			}),
		).toBe(true);
		expect(
			shouldAutoLinkForeground({
				sshManaged: false,
				noAccount: false,
				cloudWorkspaceId: "workspace_123",
			}),
		).toBe(false);
		expect(
			shouldAutoLinkForeground({
				sshManaged: false,
				noAccount: true,
			}),
		).toBe(false);
	});

	it("reads the daemon's pairing bootstrap and ignores expired ones", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "zuse-serve-pairing-"));
		const future = new Date(Date.now() + 60_000).toISOString();
		await writeFile(
			join(dataDir, "pairing.json"),
			JSON.stringify({
				browserUrl: "http://192.168.1.50:4859/#pair=ABCDEFGH",
				qrText: "zuse:///connect/pair?pairingUrl=x#token=ABCDEFGH",
				code: "ABCDEFGH",
				expiresAt: future,
			}),
		);
		await expect(readServePairingBootstrap(dataDir)).resolves.toMatchObject({
			code: "ABCDEFGH",
			expiresAt: future,
		});

		await writeFile(
			join(dataDir, "pairing.json"),
			JSON.stringify({
				browserUrl: "http://192.168.1.50:4859/#pair=ABCDEFGH",
				qrText: "zuse:///connect/pair?pairingUrl=x#token=ABCDEFGH",
				expiresAt: new Date(Date.now() - 1_000).toISOString(),
			}),
		);
		await expect(readServePairingBootstrap(dataDir)).resolves.toBeNull();
		await rm(dataDir, { recursive: true, force: true });
	});

	it("round-trips persisted serve settings", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "zuse-serve-settings-"));
		await writeServeSettings(dataDir, {
			sshManaged: false,
			tailscale: true,
			noAccount: false,
			lan: true,
			port: 5000,
		});
		await expect(readServeSettings(dataDir)).resolves.toMatchObject({
			tailscale: true,
			lan: true,
			port: 5000,
		});
		await rm(dataDir, { recursive: true, force: true });
	});

	it("resolves the bundled browser client next to the CLI", async () => {
		const bundleDir = await mkdtemp(join(tmpdir(), "zuse-serve-static-"));
		await mkdir(join(bundleDir, "client"), { recursive: true });
		await writeFile(join(bundleDir, "client", "index.html"), "<html></html>");
		const moduleUrl = `file://${join(bundleDir, "serve-cli.mjs")}`;
		expect(resolveServeStaticDir({}, moduleUrl)).toBe(
			join(bundleDir, "client"),
		);
		expect(resolveServeStaticDir({ ZUSE_STATIC_DIR: "/elsewhere" })).toBe(
			"/elsewhere",
		);
		await rm(bundleDir, { recursive: true, force: true });
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
