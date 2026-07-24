import type { DiagnosticEvent, DiagnosticSeverity } from "@zuse/contracts";

export const DIAGNOSTICS_PREFERENCES_KEY =
	"zuse.diagnostics.workspace-preferences.v1";

export const DIAGNOSTICS_VIEWS = [
	"issues",
	"logs",
	"performance",
	"processes",
	"storage",
] as const;

export type DiagnosticsView = (typeof DIAGNOSTICS_VIEWS)[number];
export type DiagnosticsSeverityFilter = DiagnosticSeverity | "all";

export type DiagnosticsPreferences = {
	readonly view: DiagnosticsView;
	readonly rangeMs: number;
	readonly severity: DiagnosticsSeverityFilter;
	readonly source: string;
	readonly search: string;
};

export const DIAGNOSTICS_RANGE_OPTIONS = [
	{ label: "15m", milliseconds: 15 * 60_000 },
	{ label: "1h", milliseconds: 60 * 60_000 },
	{ label: "24h", milliseconds: 24 * 60 * 60_000 },
	{ label: "7d", milliseconds: 7 * 24 * 60 * 60_000 },
] as const;

export const DEFAULT_DIAGNOSTICS_PREFERENCES: DiagnosticsPreferences = {
	view: "issues",
	rangeMs: DIAGNOSTICS_RANGE_OPTIONS[2].milliseconds,
	severity: "all",
	source: "",
	search: "",
};

const SEVERITIES: ReadonlySet<string> = new Set([
	"all",
	"debug",
	"info",
	"warn",
	"error",
	"fatal",
]);
const VIEWS: ReadonlySet<string> = new Set(DIAGNOSTICS_VIEWS);
const RANGES: ReadonlySet<number> = new Set(
	DIAGNOSTICS_RANGE_OPTIONS.map((option) => option.milliseconds),
);

export function parseDiagnosticsPreferences(
	value: string | null,
): DiagnosticsPreferences {
	if (!value) return DEFAULT_DIAGNOSTICS_PREFERENCES;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== "object") {
			return DEFAULT_DIAGNOSTICS_PREFERENCES;
		}
		const candidate = parsed as Record<string, unknown>;
		return {
			view:
				typeof candidate.view === "string" && VIEWS.has(candidate.view)
					? (candidate.view as DiagnosticsView)
					: DEFAULT_DIAGNOSTICS_PREFERENCES.view,
			rangeMs:
				typeof candidate.rangeMs === "number" && RANGES.has(candidate.rangeMs)
					? candidate.rangeMs
					: DEFAULT_DIAGNOSTICS_PREFERENCES.rangeMs,
			severity:
				typeof candidate.severity === "string" &&
				SEVERITIES.has(candidate.severity)
					? (candidate.severity as DiagnosticsSeverityFilter)
					: DEFAULT_DIAGNOSTICS_PREFERENCES.severity,
			source: typeof candidate.source === "string" ? candidate.source : "",
			search: typeof candidate.search === "string" ? candidate.search : "",
		};
	} catch {
		return DEFAULT_DIAGNOSTICS_PREFERENCES;
	}
}

export type DiagnosticIncident = {
	readonly event: DiagnosticEvent;
	readonly occurrences: number;
};

const severityRank: Record<DiagnosticSeverity, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
	fatal: 4,
};

export function groupDiagnosticEvents(
	events: ReadonlyArray<DiagnosticEvent>,
	knownCounts: ReadonlyMap<string, number> = new Map(),
): ReadonlyArray<DiagnosticIncident> {
	const groups = new Map<
		string,
		{ event: DiagnosticEvent; occurrences: number }
	>();
	for (const event of events) {
		const current = groups.get(event.fingerprint);
		if (!current) {
			groups.set(event.fingerprint, { event, occurrences: 1 });
			continue;
		}
		current.occurrences += 1;
		if (Date.parse(event.createdAt) > Date.parse(current.event.createdAt)) {
			current.event = event;
		}
	}

	return [...groups.values()]
		.map((group) => ({
			...group,
			occurrences: Math.max(
				group.occurrences,
				knownCounts.get(group.event.fingerprint) ?? 0,
			),
		}))
		.sort((left, right) => {
			const time =
				Date.parse(right.event.createdAt) - Date.parse(left.event.createdAt);
			if (time !== 0) return time;
			return (
				severityRank[right.event.severity] - severityRank[left.event.severity]
			);
		});
}

export function relatedDiagnosticEvents(
	events: ReadonlyArray<DiagnosticEvent>,
	fingerprint: string,
): ReadonlyArray<DiagnosticEvent> {
	return events
		.filter((event) => event.fingerprint === fingerprint)
		.sort(
			(left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
		);
}
