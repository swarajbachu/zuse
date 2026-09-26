import { expect, test } from "vitest";
import type { CloudSyncStatus } from "../../src/lib/bridge.ts";
import { cloudSyncPresentation } from "../../src/lib/cloud-sync-presentation.ts";

const status: CloudSyncStatus = {
	workspaceId: "w",
	enabled: true,
	state: "idle",
	localPath: null,
	lastSyncedAt: null,
	error: null,
	accessRefreshRequired: false,
};
test("missing and idle workers are never described as transfers", () => {
	expect(cloudSyncPresentation(null).label).toBe("Sync paused");
	expect(cloudSyncPresentation(status).label).toBe("Sync paused");
	expect(cloudSyncPresentation({ ...status, state: "pending" }).label).toBe(
		"Connecting to workspace…",
	);
});
test("transfer progress and failures are visible and distinct", () => {
	const view = cloudSyncPresentation({
		...status,
		state: "syncing",
		progress: { phase: "downloading", files: 20, total: 100, bytes: 1048576 },
	});
	expect(view.label).toBe("Receiving 20 / 100 files");
	expect(view.detail).toContain("1.0 MB received");
	expect(
		cloudSyncPresentation({
			...status,
			state: "error",
			error: "Connection lost",
		}).detail,
	).toBe("Connection lost");
});
