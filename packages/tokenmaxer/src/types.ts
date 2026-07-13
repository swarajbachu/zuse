export type UsageSourceId =
	| "zuse"
	| "memoize"
	| "claude"
	| "codex"
	| "opencode"
	| "amp"
	| "pi"
	| "grok";

export type UsageBucket = "daily" | "weekly" | "monthly" | "session";

export type UsageConfidence = "exact" | "partial" | "estimated";

export interface TokenCounts {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheCreationTokens: number;
	readonly reasoningTokens: number;
}

export interface UsageRecord extends TokenCounts {
	readonly id: string;
	readonly sourceId: UsageSourceId;
	readonly sourceLabel: string;
	readonly providerId: string;
	readonly model: string;
	readonly sessionId: string | null;
	readonly projectPath: string | null;
	readonly workspacePath: string | null;
	readonly startedAt: Date;
	readonly endedAt: Date;
	readonly costUsd: number | null;
	readonly costStatus: "known" | "unknown";
	/** Cost reported by the source log (used as-is in `auto` mode). Internal. */
	readonly loggedCostUsd: number | null;
	/** Fast/priority service tier — applies the model's fast price multiplier. Internal. */
	readonly fast: boolean;
	readonly provenance: string;
	readonly confidence: UsageConfidence;
	readonly fingerprint: string;
	readonly possibleDuplicate: boolean;
}

export interface UsageFilters {
	readonly bucket?: UsageBucket;
	readonly sourceIds?: ReadonlyArray<UsageSourceId>;
	readonly providerIds?: ReadonlyArray<string>;
	readonly since?: Date;
	readonly until?: Date;
	readonly timezone?: string;
	/**
	 * Restrict to records whose project/workspace path matches one of these
	 * roots (exact, or a parent/child directory of a root). Used to scope a
	 * report to a single codebase across all of its worktrees and sessions.
	 */
	readonly projectPaths?: ReadonlyArray<string>;
	readonly includePossibleDuplicates?: boolean;
	readonly noCost?: boolean;
}

export interface UsageSummary extends TokenCounts {
	readonly costUsd: number | null;
	readonly costStatus: "known" | "partial" | "unknown";
	readonly recordCount: number;
	readonly possibleDuplicateCount: number;
}

export interface UsageGroup extends UsageSummary {
	readonly key: string;
	readonly label: string;
	readonly startedAt: Date | null;
	readonly endedAt: Date | null;
	readonly sourceIds: ReadonlyArray<UsageSourceId>;
}

export interface UsageReport {
	readonly bucket: UsageBucket;
	readonly generatedAt: Date;
	readonly filters: UsageFilters;
	readonly summary: UsageSummary;
	readonly groups: ReadonlyArray<UsageGroup>;
	readonly bySource: ReadonlyArray<UsageGroup>;
	readonly byModel: ReadonlyArray<UsageGroup>;
	readonly bySession: ReadonlyArray<UsageGroup>;
	readonly records: ReadonlyArray<UsageRecord>;
	readonly sources: ReadonlyArray<UsageSourceStatus>;
}

export interface UsageSourceStatus {
	readonly id: UsageSourceId;
	readonly label: string;
	readonly detected: boolean;
	readonly recordCount: number;
	readonly paths: ReadonlyArray<string>;
	readonly warning: string | null;
}

export interface UsageSourceReadResult {
	readonly status: UsageSourceStatus;
	readonly records: ReadonlyArray<UsageRecord>;
}

export interface UsageReadOptions {
	readonly sourceIds?: ReadonlyArray<UsageSourceId>;
	readonly zuseDbPath?: string;
	readonly memoizeDbPath?: string;
	readonly dataDirs?: ReadonlyArray<string>;
	readonly includeExternal?: boolean;
}
