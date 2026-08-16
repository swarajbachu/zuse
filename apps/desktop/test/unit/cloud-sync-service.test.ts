import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
	CloudSyncManager,
	type CloudSyncStatus,
	cloudSyncDefaultPath,
	remoteRsyncMissing,
	rsyncArgs,
	SYNC_MARKER_FILE,
	supportsGitignoreFilter,
} from "../../src/sync/cloud-sync-service.ts";

describe("cloud sync service", () => {
	test("uses the managed repository and branch path", () => {
		expect(cloudSyncDefaultPath("/Users/me", "owner/zuse.git", "pikachu")).toBe(
			"/Users/me/.zuse/cloud/zuse/pikachu",
		);
		expect(cloudSyncDefaultPath("/Users/me", "zuse", "../escape")).toBeNull();
	});

	test("rsync arguments mirror one-way with .git and marker excluded", () => {
		const args = rsyncArgs({
			hostAlias: "zuse-workspace_abc",
			remotePath: "/home/zuse/workspace",
			localPath: "/tmp/mirror",
			sshConfigPath: "/home/u/.zuse/ssh/config",
			gitignoreFilter: true,
		});
		expect(args).toEqual([
			"-az",
			"--delete",
			"--exclude=.git/",
			`--exclude=${SYNC_MARKER_FILE}`,
			"--exclude=node_modules/",
			"--exclude=.cache/",
			"--exclude=.turbo/",
			"--exclude=.next/cache/",
			"--exclude=__pycache__/",
			"--exclude=.pytest_cache/",
			"--filter=:- .gitignore",
			"-e",
			'ssh -F "/home/u/.zuse/ssh/config"',
			"zuse-workspace_abc:/home/zuse/workspace/",
			"/tmp/mirror/",
		]);
		expect(
			rsyncArgs({
				hostAlias: "zuse-a",
				remotePath: "/home/zuse/workspace/",
				localPath: "/tmp/mirror/",
				sshConfigPath: "/c",
				gitignoreFilter: false,
			}),
		).toContain("--rsync-path=rsync --filter=':- .gitignore'");
	});

	test("gitignore filter only with GNU rsync", () => {
		expect(
			supportsGitignoreFilter("rsync  version 3.2.7  protocol version 31"),
		).toBe(true);
		expect(supportsGitignoreFilter("openrsync: protocol version 27")).toBe(
			false,
		);
	});

	test("recognizes an old sandbox without remote rsync", () => {
		expect(remoteRsyncMissing("bash: line 1: rsync: command not found")).toBe(
			true,
		);
		expect(remoteRsyncMissing("rsync: connection unexpectedly closed")).toBe(
			false,
		);
	});

	test("refuses a non-empty local directory without the sync marker", async () => {
		const dir = await mkdtemp(join(tmpdir(), "zuse-sync-"));
		await writeFile(join(dir, "precious.txt"), "do not clobber");
		const events: Array<CloudSyncStatus> = [];
		const manager = new CloudSyncManager(
			(status) => events.push(status),
			async () => ({ code: 0, stderr: "" }),
		);
		const status = await manager.configure({
			workspaceId: "workspace_abc",
			enabled: true,
			localPath: dir,
			hostAlias: "zuse-workspace_abc",
			remotePath: "/home/zuse/workspace",
		});
		expect(status.state).toBe("error");
		expect(status.error).toContain("not empty");
		manager.dispose();
	});

	test("syncs an empty directory and reaches in-sync", async () => {
		const dir = await mkdtemp(join(tmpdir(), "zuse-sync-"));
		const runs: Array<ReadonlyArray<string>> = [];
		const manager = new CloudSyncManager(
			() => {},
			async (args) => {
				runs.push(args);
				return { code: 0, stderr: "" };
			},
		);
		await manager.configure({
			workspaceId: "workspace_abc",
			enabled: true,
			localPath: dir,
			hostAlias: "zuse-workspace_abc",
			remotePath: "/home/zuse/workspace",
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(runs.length).toBe(1);
		expect(manager.status("workspace_abc").state).toBe("in-sync");
		expect(manager.status("workspace_abc").lastSyncedAt).not.toBeNull();
		manager.dispose();
	});

	test("falls back for old sandboxes without rsync", async () => {
		const dir = await mkdtemp(join(tmpdir(), "zuse-sync-"));
		let fallbackRuns = 0;
		const manager = new CloudSyncManager(
			() => {},
			async () => ({
				code: 127,
				stderr: "bash: line 1: rsync: command not found",
			}),
			async () => {
				fallbackRuns += 1;
				return { code: 0, stderr: "" };
			},
		);
		await manager.configure({
			workspaceId: "workspace_old",
			enabled: true,
			localPath: dir,
			hostAlias: "zuse-workspace_old",
			remotePath: "/home/zuse/workspace",
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fallbackRuns).toBe(1);
		expect(manager.status("workspace_old").state).toBe("in-sync");
		manager.dispose();
	});

	test("reports rsync failures with stderr tail and recovers on disable", async () => {
		const dir = await mkdtemp(join(tmpdir(), "zuse-sync-"));
		const manager = new CloudSyncManager(
			() => {},
			async () => ({
				code: 12,
				stderr: "rsync: connection unexpectedly closed",
			}),
		);
		await manager.configure({
			workspaceId: "workspace_abc",
			enabled: true,
			localPath: dir,
			hostAlias: "zuse-workspace_abc",
			remotePath: "/home/zuse/workspace",
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(manager.status("workspace_abc").state).toBe("error");
		expect(manager.status("workspace_abc").error).toContain(
			"connection unexpectedly closed",
		);
		await manager.configure({
			workspaceId: "workspace_abc",
			enabled: false,
			localPath: dir,
			hostAlias: "zuse-workspace_abc",
			remotePath: "/home/zuse/workspace",
		});
		expect(manager.status("workspace_abc").enabled).toBe(false);
		expect(manager.status("workspace_abc").state).toBe("idle");
		manager.dispose();
	});
});
