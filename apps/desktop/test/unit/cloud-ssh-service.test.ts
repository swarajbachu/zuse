import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
	atomicWritePrivateFile,
	cloudSshBridgeLauncher,
	cloudSshHostAlias,
	cloudSshWorkspaceConfig,
	managedSshConfig,
	pruneExpiredCloudSshTickets,
	sshTargetLaunch,
	withUserConfigInclude,
} from "../../src/ssh/cloud-ssh-service.ts";
import { sanitizedSshBridgeFailure } from "../../src/ssh/ssh-bridge-errors.ts";

describe("cloud ssh service", () => {
	test("uses the snapshot's Linux user without changing managed workspace users", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-ssh-users-"));
		const hosts = join(directory, "workspace users");
		await mkdir(hosts);
		await writeFile(
			join(hosts, "snapshot.conf"),
			cloudSshWorkspaceConfig("snapshot", "boxd"),
		);
		const path = join(directory, "config");
		await writeFile(path, managedSshConfig("/unused-bridge", hosts));
		const user = (host: string) =>
			execFileSync("ssh", ["-G", "-T", "-F", path, host], {
				encoding: "utf8",
			}).match(/^user (.+)$/m)?.[1];
		expect(user("zuse-snapshot")).toBe("boxd");
		expect(user("zuse-managed")).toBe("zuse");
	});

	test("rejects unsafe workspace SSH config values", () => {
		expect(() => cloudSshWorkspaceConfig("snapshot\nHost *", "boxd")).toThrow();
		expect(() =>
			cloudSshWorkspaceConfig("snapshot", "boxd\nProxyCommand bad"),
		).toThrow();
		expect(() => cloudSshWorkspaceConfig("snapshot", "root")).toThrow();
	});

	test("OpenSSH reuses connections per workspace with bounded idle and dead-peer lifetimes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-ssh-config-"));
		const path = join(directory, "config");
		await writeFile(path, managedSshConfig("/unused-bridge"));
		const settings = (host: string) =>
			Object.fromEntries(
				execFileSync("ssh", ["-G", "-T", "-F", path, host], {
					encoding: "utf8",
				})
					.trim()
					.split("\n")
					.map((line) => {
						const space = line.indexOf(" ");
						return [line.slice(0, space), line.slice(space + 1)];
					}),
			);
		const first = settings("zuse-workspace_one");
		const second = settings("zuse-workspace_two");
		expect(first.controlmaster).toBe("auto");
		expect(first.controlpersist).toBe("120");
		expect(first.serveraliveinterval).toBe("10");
		expect(first.serveralivecountmax).toBe("3");
		expect(first.controlpath).toContain("/.zuse/ssh/");
		expect(first.controlpath).not.toBe(second.controlpath);
		expect(settings("unrelated-host").controlmaster).toBe("false");
	});

	test("managed config wires the bridge as ProxyCommand for zuse-* hosts", () => {
		const config = managedSshConfig(
			'env ELECTRON_RUN_AS_NODE=1 "/app" "/b.cjs"',
		);
		expect(config).toContain("Host zuse-*");
		expect(config).toContain("User zuse");
		expect(config).toContain(
			'ProxyCommand env ELECTRON_RUN_AS_NODE=1 "/app" "/b.cjs" %n',
		);
		expect(config).toContain("IdentitiesOnly yes");
	});

	test("user config include is prepended once and only once", () => {
		const first = withUserConfigInclude(
			"Host other\n",
			"/home/u/.zuse/ssh/config",
		);
		expect(first).toContain("Include /home/u/.zuse/ssh/config");
		expect(first?.endsWith("Host other\n")).toBe(true);
		expect(
			withUserConfigInclude(first ?? "", "/home/u/.zuse/ssh/config"),
		).toBeNull();
	});

	test("stable launcher quotes paths and selects the packaged runtime mode", () => {
		expect(
			cloudSshBridgeLauncher(
				{
					executable: "/Applications/Zuse Alpha.app/Contents/MacOS/Zuse Alpha",
					electronRunAsNode: true,
				},
				"/Users/me/.zuse/ssh/bridge/ssh-bridge-child.cjs",
			),
		).toBe(
			"#!/bin/sh\nexec env ELECTRON_RUN_AS_NODE=1 '/Applications/Zuse Alpha.app/Contents/MacOS/Zuse Alpha' '/Users/me/.zuse/ssh/bridge/ssh-bridge-child.cjs' \"$@\"\n",
		);
	});

	test("private files replace atomically with owner-only permissions", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-ssh-atomic-"));
		const path = join(directory, "bridge", "launch");
		await atomicWritePrivateFile(path, "first", 0o700);
		await atomicWritePrivateFile(path, "second", 0o700);
		expect(await readFile(path, "utf8")).toBe("second");
		expect((await stat(path)).mode & 0o777).toBe(0o700);
	});

	test("expired and invalid managed tickets are pruned", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-ssh-tickets-"));
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "fresh.json"), '{"expiresAt":2000}');
		await writeFile(join(directory, "expired.json"), '{"expiresAt":999}');
		await writeFile(join(directory, "invalid.json"), "not-json");
		await pruneExpiredCloudSshTickets(directory, 1_000);
		expect(await readFile(join(directory, "fresh.json"), "utf8")).toContain(
			"2000",
		);
		await expect(readFile(join(directory, "expired.json"))).rejects.toThrow();
		await expect(readFile(join(directory, "invalid.json"))).rejects.toThrow();
	});

	test("bridge failures are sanitized and actionable", () => {
		expect(
			sanitizedSshBridgeFailure({ detail: "Unexpected server response: 401" }),
		).toContain("rejected");
		expect(
			sanitizedSshBridgeFailure({ detail: "The sandbox was not found" }),
		).toContain("not running");
		expect(sanitizedSshBridgeFailure({ detail: "502 Bad Gateway" })).toContain(
			"could not reach",
		);
		expect(sanitizedSshBridgeFailure({ timedOut: true })).toContain(
			"timed out",
		);
		expect(sanitizedSshBridgeFailure({ closeCode: 1006 })).toContain("1006");
		expect(
			sanitizedSshBridgeFailure({ detail: "wss://secret/?ticket=secret" }),
		).not.toContain("secret");
	});

	test("ssh target launches", () => {
		const alias = cloudSshHostAlias("workspace_abc");
		expect(alias).toBe("zuse-workspace_abc");
		expect(sshTargetLaunch("cursor", alias, "/home/zuse/workspace")).toEqual({
			kind: "uri",
			uri: "cursor://vscode-remote/ssh-remote+zuse-workspace_abc/home/zuse/workspace",
		});
		expect(sshTargetLaunch("zed", alias, "/home/zuse/workspace")).toEqual({
			kind: "uri",
			uri: "zed://ssh/zuse@zuse-workspace_abc/home/zuse/workspace",
		});
		expect(sshTargetLaunch("terminal", alias, "/home/zuse/workspace")).toEqual({
			kind: "terminal",
			command: "ssh zuse-workspace_abc",
		});
		expect(sshTargetLaunch("unknown", alias, "/x")).toBeNull();
	});
});
