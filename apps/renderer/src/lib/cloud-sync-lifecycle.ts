/** Cloud readiness owns sync eligibility; the legacy environment catalog may be empty. */
export const reconcileAutomaticCloudSyncs = (input: {
	readonly summaries: ReadonlyArray<{
		readonly workspaceId: string;
		readonly state: string;
	}>;
	readonly activeWorkspaceIds: ReadonlySet<string>;
	readonly enabled: (workspaceId: string) => boolean;
	readonly start: (workspaceId: string) => void;
	readonly stop: (workspaceId: string) => void;
}): void => {
	const available = new Set(
		input.summaries
			.filter((summary) => summary.state === "ready")
			.map((summary) => summary.workspaceId),
	);
	for (const workspaceId of input.activeWorkspaceIds) {
		if (!available.has(workspaceId) || !input.enabled(workspaceId))
			input.stop(workspaceId);
	}
	for (const summary of input.summaries) {
		if (
			summary.state === "ready" &&
			input.enabled(summary.workspaceId) &&
			!input.activeWorkspaceIds.has(summary.workspaceId)
		)
			input.start(summary.workspaceId);
	}
};

/** Serialize start/stop work per workspace so reconnects cannot race teardown. */
export { KeyedSerialWorker as CloudSyncLifecycleQueue } from "@zuse/utils/keyed-worker";
