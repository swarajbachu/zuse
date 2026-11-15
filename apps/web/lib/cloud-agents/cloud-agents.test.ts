import { describe, expect, it } from "vitest";
import {
	AGENT_ROWS,
	CATEGORIES,
	CHECKED_ON,
	DIRECTORY_META,
	FEATURE_KEYS,
	PLATFORM_KEYS,
	reputationScore,
	toTableRow,
} from "./index";
import type { Evidence } from "./types";

const isUrl = (value: string | null | undefined) => {
	if (!value) return false;
	try {
		return ["http:", "https:"].includes(new URL(value).protocol);
	} catch {
		return false;
	}
};

const allEvidence = (
	row: (typeof AGENT_ROWS)[number],
): [string, Evidence][] => [
	["openSource", row.openSource],
	...(row.freeTier
		? ([["freeTier", row.freeTier]] as [string, Evidence][])
		: []),
	...FEATURE_KEYS.map((k) => [k, row.features[k]] as [string, Evidence]),
	...PLATFORM_KEYS.map((k) => [k, row.platforms[k]] as [string, Evidence]),
];

describe("cloud coding agents data", () => {
	it("has several hundred unique rows", () => {
		expect(AGENT_ROWS.length).toBeGreaterThanOrEqual(300);
		const ids = AGENT_ROWS.map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
		const repos = AGENT_ROWS.map((r) => r.repoUrl?.toLowerCase()).filter(
			Boolean,
		);
		expect(new Set(repos).size).toBe(repos.length);
	});

	it("records a source URL for every row", () => {
		for (const row of AGENT_ROWS) {
			expect(isUrl(row.url), row.id).toBe(true);
			expect(isUrl(row.descriptionSource), row.id).toBe(true);
			if (row.pricing) expect(isUrl(row.pricing.src), row.id).toBe(true);
			if (row.since && row.verification !== "hand")
				expect(isUrl(row.sinceSource), row.id).toBe(true);
		}
	});

	it("backs every yes/no cell with an evidence URL", () => {
		for (const row of AGENT_ROWS) {
			for (const [key, ev] of allEvidence(row)) {
				expect(["yes", "no", "unknown"], `${row.id}.${key}`).toContain(ev.v);
				if (ev.v !== "unknown")
					expect(isUrl(ev.src), `${row.id}.${key}`).toBe(true);
			}
			if (row.agents.names.length || row.agents.acp)
				expect(isUrl(row.agents.src), `${row.id}.agents`).toBe(true);
		}
	});

	it("never marks automatically extracted rows as 'no'", () => {
		for (const row of AGENT_ROWS.filter((r) => r.verification !== "hand")) {
			for (const [key, ev] of allEvidence(row))
				expect(ev.v, `${row.id}.${key}`).not.toBe("no");
		}
	});

	it("uses known categories", () => {
		for (const row of AGENT_ROWS) expect(CATEGORIES).toContain(row.category);
	});

	it("keeps the Zuse row honest about price", () => {
		const zuse = AGENT_ROWS.find((r) => r.id === "zuse");
		expect(zuse?.freeTier?.v).toBe("no");
		expect(zuse?.pricing?.headline).toContain("$40");
		expect(zuse?.license).toBe("AGPL-3.0");
	});

	it("stamps the check date and lists exclusions", () => {
		expect(DIRECTORY_META.checkedOn).toBe(CHECKED_ON);
		for (const e of DIRECTORY_META.excluded)
			expect(e.reason.length).toBeGreaterThan(0);
	});

	it("ships only values, not evidence quotes, to the client table", () => {
		const row = toTableRow(AGENT_ROWS[0]);
		expect(JSON.stringify(row)).not.toContain('"quote"');
		expect(row.sources.every(isUrl)).toBe(true);
	});
});

describe("reputation score", () => {
	const max = { stars: 100_000, hnStories: 400 };

	it("log-scales each signal against the page maximum", () => {
		expect(reputationScore({ stars: 100_000, hnStories: 400 }, max)).toBe(100);
		expect(reputationScore({ stars: 0, hnStories: 0 }, max)).toBe(0);
		expect(reputationScore({ stars: 100_000, hnStories: null }, max)).toBe(100);
	});

	it("returns null when no public signal exists", () => {
		expect(reputationScore({ stars: null, hnStories: null }, max)).toBeNull();
	});

	it("stays within 0..100 for every row", () => {
		for (const row of AGENT_ROWS) {
			const s = row.reputation.score;
			if (s !== null) {
				expect(s).toBeGreaterThanOrEqual(0);
				expect(s).toBeLessThanOrEqual(100);
			}
		}
	});
});
