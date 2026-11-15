/**
 * Data model for /cloud-coding-agents.
 *
 * Every boolean-like cell is a `Tri` with the URL it was read from. "unknown"
 * renders as "—": we could not find the answer in a primary source on the
 * check date, which is not the same as "no".
 */
export type Tri = "yes" | "no" | "unknown";

export interface Evidence {
	v: Tri;
	/** Primary source the value was read from. Required unless `v` is "unknown". */
	src?: string;
	/** Short excerpt or description of what the source says. */
	quote?: string;
}

export const CATEGORIES = [
	"Cloud agent",
	"Agent workspace",
	"Terminal agent",
	"IDE agent",
	"App builder",
	"Code review",
	"Task runner",
	"Multi-agent swarm",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const FEATURE_KEYS = [
	"cloud",
	"remote",
	"orchestration",
	"byo",
	"mcp",
	"plugins",
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const PLATFORM_KEYS = [
	"macos",
	"windows",
	"linux",
	"web",
	"ios",
	"android",
] as const;
export type PlatformKey = (typeof PLATFORM_KEYS)[number];

export type Verification = "hand" | "auto" | "auto-homepage";

export interface AgentRow {
	id: string;
	name: string;
	url: string;
	repoUrl?: string | null;
	category: Category;
	/** Lifecycle flag such as "Shutting down", "Acquired", "Archived". */
	status?: string | null;
	description: string | null;
	descriptionSource: string;
	/** ISO date (or YYYY-MM) of launch, or repository creation for open source rows. */
	since: string | null;
	sinceSource?: string | null;
	sinceNote?: string | null;
	/** Last push to the default repository, open source rows only. */
	pushedAt?: string | null;
	pricing?: { headline: string; detail?: string; src: string } | null;
	freeTier?: Evidence | null;
	/** SPDX id, "Proprietary", or null when unknown. */
	license: string | null;
	licenseSource?: string | null;
	openSource: Evidence;
	agents: {
		names: string[];
		/** Supports any Agent Client Protocol agent. */
		acp: boolean;
		src?: string;
		note?: string;
	};
	integrations: { names: string[]; src?: string };
	features: Record<FeatureKey, Evidence>;
	platforms: Record<PlatformKey, Evidence>;
	reputation: {
		score: number | null;
		stars: number | null;
		hnStories: number | null;
		repo?: string | null;
		hnQueries?: string[];
	};
	notes?: string | null;
	compare?: { href: string; label: string } | null;
	verification: Verification;
}
