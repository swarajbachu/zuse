export interface PowerRuntimeActivity {
	readonly activeAgents: number;
	readonly activeTerminals: number;
	readonly browserSessions: number;
	readonly activeBrowserSessions: number;
	readonly browserRecordings: number;
	readonly indexing: boolean;
}

let activity: PowerRuntimeActivity = {
	activeAgents: 0,
	activeTerminals: 0,
	browserSessions: 0,
	activeBrowserSessions: 0,
	browserRecordings: 0,
	indexing: false,
};
const listeners = new Set<() => void>();
const browserSessions = new Map<string, boolean>();

export const getPowerRuntimeActivity = (): PowerRuntimeActivity => activity;

export const subscribePowerRuntimeActivity = (
	listener: () => void,
): (() => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

const publish = (next: PowerRuntimeActivity): void => {
	if (
		next.activeAgents === activity.activeAgents &&
		next.activeTerminals === activity.activeTerminals &&
		next.browserSessions === activity.browserSessions &&
		next.activeBrowserSessions === activity.activeBrowserSessions &&
		next.browserRecordings === activity.browserRecordings &&
		next.indexing === activity.indexing
	) {
		return;
	}
	activity = next;
	for (const listener of listeners) listener();
};

export const setPowerActiveAgentCount = (count: number): void => {
	publish({ ...activity, activeAgents: Math.max(0, count) });
};

export const setPowerActiveTerminalCount = (count: number): void => {
	publish({ ...activity, activeTerminals: Math.max(0, count) });
};

export const reportPowerBrowserSession = (
	id: string,
	active: boolean | null,
): void => {
	if (active === null) browserSessions.delete(id);
	else browserSessions.set(id, active);
	publish({
		...activity,
		browserSessions: browserSessions.size,
		activeBrowserSessions: [...browserSessions.values()].filter(Boolean).length,
	});
};

export const reportPowerBrowserRecordingStarted = (): void => {
	publish({ ...activity, browserRecordings: activity.browserRecordings + 1 });
};

export const reportPowerBrowserRecordingStopped = (): void => {
	publish({
		...activity,
		browserRecordings: Math.max(0, activity.browserRecordings - 1),
	});
};

export const setPowerIndexing = (indexing: boolean): void => {
	publish({ ...activity, indexing });
};
