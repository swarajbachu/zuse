export interface ExtensionAgentSession {
	readonly id: string;
	readonly projectId: string;
	readonly projectName: string;
	readonly title: string;
	readonly providerId: string;
	readonly model: string;
	readonly status: "booting" | "running" | "idle" | "error" | "closed";
	readonly updatedAt: string;
}
export interface ExtensionSessionsSnapshot {
	readonly sessions: ReadonlyArray<ExtensionAgentSession>;
	readonly loading: boolean;
	readonly stale: boolean;
	readonly error: string | null;
}
export interface ExtensionPullRequestSnapshot {
	readonly loading: boolean;
	readonly stale: boolean;
	readonly error: string | null;
	readonly branch: string | null;
	readonly pullRequest: {
		readonly number: number | null;
		readonly url: string | null;
		readonly state: "none" | "open" | "merged" | "closed";
		readonly isDraft: boolean;
		readonly checksRunning: number;
		readonly checksPassing: number;
		readonly checksFailing: number;
		readonly checksTotal: number;
	} | null;
}
export interface ExtensionClientHost {
	/** Latest current-turn plan or assistant output, capped at 128 KiB. Requires planning. */
	readonly usePlanOutput: (sessionId: string | null) => {
		readonly text: string;
		readonly truncated: boolean;
		readonly stale: boolean;
	};
	/** Enter Plan mode and attach instructions for user submission. Requires planning. */
	readonly preparePlan: (
		sessionId: string,
		instructions: string,
	) => Promise<void>;
	/** Non-archived sessions across local projects. Requires sessions. */
	readonly useSessions: () => ExtensionSessionsSnapshot;
	/** Shared, live branch PR resource. Mount only for visible cards. Requires sessions. */
	readonly usePullRequest: (sessionId: string) => ExtensionPullRequestSnapshot;
	/** Opens an existing local conversation; does not send a message. Requires sessions. */
	readonly openSession: (sessionId: string) => Promise<void>;
}
