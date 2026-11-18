import { CORE_ROWS } from "./core";
import directoryJson from "./directory.json";
import {
	type AgentRow,
	CATEGORIES,
	type Category,
	FEATURE_KEYS,
	type FeatureKey,
	PLATFORM_KEYS,
	type PlatformKey,
	type Tri,
} from "./types";

export * from "./types";

/** Date every row on the page was checked against its sources. */
export const CHECKED_ON = "2026-11-15";
export const CHECKED_ON_LABEL = "15 November 2026";
export const CORRECTIONS_EMAIL = "hi@zuse.sh";

/** Search-result description; kept under the ~160 characters engines display. */
export function directoryMetaDescription(count: number): string {
	return `${count} cloud coding agents, workspaces and CLIs compared on cloud and self-hosted runs, MCP, plugins, platforms, license and price. Checked ${CHECKED_ON_LABEL}.`;
}

interface DirectoryFile {
	meta: {
		checkedOn: string;
		hnSource: string;
		starsSource: string;
		excluded: { id: string; reason: string }[];
	};
	rows: AgentRow[];
}

const directory = directoryJson as unknown as DirectoryFile;
export const DIRECTORY_META = directory.meta;

/**
 * Reputation, 0 to 100. Each available signal is log-scaled against the
 * largest value on the page, then the signals are averaged:
 *
 *   stars  = log10(1 + GitHub stars) / log10(1 + max stars)
 *   hn     = log10(1 + Hacker News stories linking the site or repo) / log10(1 + max)
 *   score  = round(100 × mean(available signals))
 *
 * A row with neither signal has no score ("—").
 */
export function reputationScore(
	signals: { stars: number | null; hnStories: number | null },
	max: { stars: number; hnStories: number },
): number | null {
	const parts: number[] = [];
	if (signals.stars !== null && max.stars > 0)
		parts.push(Math.log10(1 + signals.stars) / Math.log10(1 + max.stars));
	if (signals.hnStories !== null && max.hnStories > 0)
		parts.push(
			Math.log10(1 + signals.hnStories) / Math.log10(1 + max.hnStories),
		);
	if (parts.length === 0) return null;
	return Math.round((100 * parts.reduce((a, b) => a + b, 0)) / parts.length);
}

function withScores(rows: AgentRow[]): AgentRow[] {
	const max = {
		stars: Math.max(0, ...rows.map((r) => r.reputation.stars ?? 0)),
		hnStories: Math.max(0, ...rows.map((r) => r.reputation.hnStories ?? 0)),
	};
	return rows.map((row) => ({
		...row,
		reputation: {
			...row.reputation,
			score: reputationScore(row.reputation, max),
		},
	}));
}

export const AGENT_ROWS: AgentRow[] = withScores([
	...CORE_ROWS,
	...directory.rows,
]);

export const REPUTATION_MAX = {
	stars: Math.max(...AGENT_ROWS.map((r) => r.reputation.stars ?? 0)),
	hnStories: Math.max(...AGENT_ROWS.map((r) => r.reputation.hnStories ?? 0)),
};

/** Compact row shape sent to the client table; evidence quotes stay on the server. */
export interface TableRow {
	id: string;
	name: string;
	url: string;
	repoUrl: string | null;
	category: Category;
	status: string | null;
	description: string | null;
	since: string | null;
	sinceNote: string | null;
	pushedAt: string | null;
	pricing: string | null;
	pricingDetail: string | null;
	freeCloud: Tri;
	license: string | null;
	openSource: Tri;
	agents: string[];
	acp: boolean;
	agentsNote: string | null;
	integrations: string[];
	features: Record<FeatureKey, Tri>;
	platforms: Record<PlatformKey, Tri>;
	reputation: number | null;
	stars: number | null;
	hnStories: number | null;
	notes: string | null;
	compare: { href: string; label: string } | null;
	verification: AgentRow["verification"];
	sources: string[];
}

export function toTableRow(row: AgentRow): TableRow {
	const sources = new Set<string>([row.descriptionSource]);
	for (const src of [
		row.pricing?.src,
		row.sinceSource,
		row.licenseSource,
		row.openSource.src,
		row.freeTier?.src,
		row.agents.src,
		row.integrations.src,
		...FEATURE_KEYS.map((k) => row.features[k].src),
		...PLATFORM_KEYS.map((k) => row.platforms[k].src),
	])
		if (src) sources.add(src);
	return {
		id: row.id,
		name: row.name,
		url: row.url,
		repoUrl: row.repoUrl ?? null,
		category: row.category,
		status: row.status ?? null,
		description: row.description,
		since: row.since,
		sinceNote: row.sinceNote ?? null,
		pushedAt: row.pushedAt ?? null,
		pricing: row.pricing?.headline ?? null,
		pricingDetail: row.pricing?.detail ?? null,
		freeCloud: row.freeTier?.v ?? "unknown",
		license: row.license,
		openSource: row.openSource.v,
		agents: row.agents.names,
		acp: row.agents.acp,
		agentsNote: row.agents.note ?? null,
		integrations: row.integrations.names,
		features: Object.fromEntries(
			FEATURE_KEYS.map((k) => [k, row.features[k].v]),
		) as Record<FeatureKey, Tri>,
		platforms: Object.fromEntries(
			PLATFORM_KEYS.map((k) => [k, row.platforms[k].v]),
		) as Record<PlatformKey, Tri>,
		reputation: row.reputation.score,
		stars: row.reputation.stars,
		hnStories: row.reputation.hnStories,
		notes: row.notes ?? null,
		compare: row.compare ?? null,
		verification: row.verification,
		sources: [...sources],
	};
}

export function categoryCounts(rows: { category: Category }[]) {
	return CATEGORIES.map((category) => ({
		category,
		count: rows.filter((r) => r.category === category).length,
	}));
}
