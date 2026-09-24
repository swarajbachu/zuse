import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
	CloudSyncManager,
	cloudSyncDefaultPath,
	SYNC_MARKER_FILE,
} from "../../src/sync/cloud-sync-service.ts";

test("default path cannot escape the managed repository/branch directory", () => {
	expect(
		cloudSyncDefaultPath("/Users/me", "owner/repo.git", "feature/sync"),
	).toBe("/Users/me/.zuse/cloud/repo/feature/sync");
	expect(cloudSyncDefaultPath("/Users/me", "repo", "../escape")).toBeNull();
});

test("refuses unrelated folders and markers belonging to another workspace", async () => {
	const localPath = await mkdtemp(join(tmpdir(), "zuse-guard-"));
	const manager = new CloudSyncManager(() => {});
	const config = {
		workspaceId: "one",
		enabled: true,
		localPath,
		hostAlias: "zuse-one",
		remotePath: "/repo",
	};
	try {
		await writeFile(join(localPath, "precious"), "keep");
		expect((await manager.configure(config)).error).toContain("not empty");
		await writeFile(
			join(localPath, SYNC_MARKER_FILE),
			JSON.stringify({ workspaceId: "two" }),
		);
		expect((await manager.configure(config)).error).toContain(
			"different cloud workspace",
		);
	} finally {
		await manager.dispose();
		await rm(localPath, { recursive: true, force: true });
	}
});
