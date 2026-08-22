/** Reconcile live sync workers with persisted preferences and connectivity. */
export const reconcileAutomaticCloudSyncs = (input: {
	readonly summaries: ReadonlyArray<{
		readonly workspaceId: string;
		readonly state: string;
	}>;
	readonly connectedWorkspaceIds: ReadonlySet<string>;
	readonly activeWorkspaceIds: ReadonlySet<string>;
	readonly enabled: (workspaceId: string) => boolean;
	readonly start: (workspaceId: string) => void;
	readonly stop: (workspaceId: string) => void;
}): void => {
	const available = new Set(
		input.summaries
			.filter((summary) => summary.state !== "archived")
			.map((summary) => summary.workspaceId),
	);
	for (const workspaceId of input.activeWorkspaceIds) {
		if (
			!available.has(workspaceId) ||
			!input.connectedWorkspaceIds.has(workspaceId)
		)
			input.stop(workspaceId);
	}
	for (const summary of input.summaries) {
		if (
			summary.state !== "archived" &&
			input.connectedWorkspaceIds.has(summary.workspaceId) &&
			input.enabled(summary.workspaceId) &&
			!input.activeWorkspaceIds.has(summary.workspaceId)
		)
			input.start(summary.workspaceId);
	}
};

/** Serialize start/stop work per workspace so reconnects cannot race teardown. */
export class CloudSyncLifecycleQueue {
	private readonly pending = new Map<string, Promise<void>>();

	run(workspaceId: string, operation: () => Promise<void>): Promise<void> {
		const previous = this.pending.get(workspaceId) ?? Promise.resolve();
		let current: Promise<void>;
		current = previous
			.catch(() => undefined)
			.then(operation)
			.finally(() => {
				if (this.pending.get(workspaceId) === current)
					this.pending.delete(workspaceId);
			});
		this.pending.set(workspaceId, current);
		return current;
	}
}
