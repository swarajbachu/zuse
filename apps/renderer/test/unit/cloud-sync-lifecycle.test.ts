import { describe, expect, it, vi } from "vitest";

import {
	CloudSyncLifecycleQueue,
	reconcileAutomaticCloudSyncs,
} from "../../src/lib/cloud-sync-lifecycle.ts";
import { cloudSyncPreferenceEnabled } from "../../src/lib/cloud-workspace-catalog.ts";

describe("cloud sync connection lifecycle", () => {
	it("preserves default-on sync until the user disables it", () => {
		expect(cloudSyncPreferenceEnabled(undefined)).toBe(true);
		expect(cloudSyncPreferenceEnabled(null)).toBe(true);
		expect(cloudSyncPreferenceEnabled({ enabled: false })).toBe(false);
		expect(cloudSyncPreferenceEnabled({ enabled: true })).toBe(true);
	});

	it("stops on disconnect and starts again when connected without changing prefs", () => {
		const start = vi.fn();
		const stop = vi.fn();
		const summaries = [{ workspaceId: "workspace_a", state: "ready" }];
		reconcileAutomaticCloudSyncs({
			summaries,
			connectedWorkspaceIds: new Set(),
			activeWorkspaceIds: new Set(["workspace_a"]),
			enabled: () => true,
			start,
			stop,
		});
		expect(stop).toHaveBeenCalledWith("workspace_a");
		expect(start).not.toHaveBeenCalled();

		stop.mockClear();
		reconcileAutomaticCloudSyncs({
			summaries,
			connectedWorkspaceIds: new Set(["workspace_a"]),
			activeWorkspaceIds: new Set(),
			enabled: () => true,
			start,
			stop,
		});
		expect(start).toHaveBeenCalledWith("workspace_a");
		expect(stop).not.toHaveBeenCalled();
	});

	it("serializes disconnect teardown before reconnect setup", async () => {
		const queue = new CloudSyncLifecycleQueue();
		const events: string[] = [];
		let releaseStop: () => void = () => undefined;
		const stop = queue.run(
			"workspace_a",
			() =>
				new Promise<void>((resolve) => {
					events.push("stop-started");
					releaseStop = () => {
						events.push("stop-finished");
						resolve();
					};
				}),
		);
		const start = queue.run("workspace_a", async () => {
			events.push("start");
		});
		await vi.waitFor(() => expect(events).toEqual(["stop-started"]));
		releaseStop();
		await Promise.all([stop, start]);
		expect(events).toEqual(["stop-started", "stop-finished", "start"]);
	});
});
