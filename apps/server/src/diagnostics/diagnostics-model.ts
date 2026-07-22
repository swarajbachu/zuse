import { createHash } from "node:crypto";

import type {
	DiagnosticEvent,
	DiagnosticFailureGroup,
	DiagnosticSeverity,
} from "@zuse/contracts";

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
	[/\b(Bearer\s+)[^\s]+/gi, "$1[REDACTED]"],
	[/([?&])[^=\s]+=[^&\s]+/g, "$1[REDACTED]"],
	[
		/\b(?:sk|ghp|github_pat|xox[abprs])[-_][A-Za-z0-9._-]{8,}\b/gi,
		"[REDACTED]",
	],
	[
		/\b([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password|credential)[A-Za-z0-9_]*)\s*[:=]\s*["']?[^\s"',;]+/gi,
		"$1=[REDACTED]",
	],
];

const EXCLUDED_EXPORT_KEYS =
	/^(?:prompt|transcript|conversation|content|environment|env|credentials?|secrets?|tokens?|terminalOutput|openFile|path|sourcePath|rawCommand)$/i;

export function sanitizeDiagnosticText(value: string): string {
	let result = value;
	for (const [pattern, replacement] of SECRET_PATTERNS) {
		result = result.replace(pattern, replacement);
	}
	return result.slice(0, 8_000);
}

export function sanitizeDiagnosticValue(value: unknown, depth = 0): unknown {
	if (depth > 8) return "[TRUNCATED]";
	if (typeof value === "string") return sanitizeDiagnosticText(value);
	if (Array.isArray(value))
		return value
			.slice(0, 500)
			.map((item) => sanitizeDiagnosticValue(item, depth + 1));
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([key]) => !EXCLUDED_EXPORT_KEYS.test(key))
			.slice(0, 500)
			.map(([key, item]) => [key, sanitizeDiagnosticValue(item, depth + 1)]),
	);
}

export function diagnosticFingerprint(input: {
	readonly source: string;
	readonly category: string;
	readonly message: string;
}): string {
	return createHash("sha256")
		.update(`${input.source}\0${input.category}\0${input.message}`)
		.digest("hex")
		.slice(0, 20);
}

export interface DiagnosticFilters {
	readonly severities?: ReadonlyArray<DiagnosticSeverity>;
	readonly source?: string;
	readonly search?: string;
	readonly since?: string;
}

export function filterDiagnosticEvents(
	events: ReadonlyArray<DiagnosticEvent>,
	filters: DiagnosticFilters,
): ReadonlyArray<DiagnosticEvent> {
	const search = filters.search?.trim().toLowerCase();
	return events.filter((event) => {
		if (filters.severities && !filters.severities.includes(event.severity))
			return false;
		if (
			filters.source &&
			!event.source.toLowerCase().includes(filters.source.toLowerCase())
		) {
			return false;
		}
		if (filters.since && event.createdAt < filters.since) return false;
		if (
			search &&
			!`${event.message} ${event.detail ?? ""} ${event.source}`
				.toLowerCase()
				.includes(search)
		)
			return false;
		return true;
	});
}

export function aggregateDiagnostics(events: ReadonlyArray<DiagnosticEvent>) {
	const sorted = [...events].sort((a, b) =>
		b.createdAt.localeCompare(a.createdAt),
	);
	const groups = new Map<string, DiagnosticFailureGroup>();
	for (const event of sorted.filter(
		(item) => item.severity !== "debug" && item.severity !== "info",
	)) {
		const current = groups.get(event.fingerprint);
		groups.set(event.fingerprint, {
			fingerprint: event.fingerprint,
			severity: event.severity,
			source: event.source,
			message: event.message,
			count: (current?.count ?? 0) + 1,
			firstSeenAt:
				current && current.firstSeenAt < event.createdAt
					? current.firstSeenAt
					: event.createdAt,
			lastSeenAt:
				current && current.lastSeenAt > event.createdAt
					? current.lastSeenAt
					: event.createdAt,
			recoveredCount:
				(current?.recoveredCount ?? 0) +
				(event.recoveryStatus === "recovered" ? 1 : 0),
		});
	}
	return {
		eventCount: events.length,
		errorCount: events.filter((event) => event.severity === "error").length,
		warningCount: events.filter((event) => event.severity === "warn").length,
		fatalCount: events.filter((event) => event.severity === "fatal").length,
		slowOperationCount: events.filter(
			(event) => (event.durationMs ?? 0) >= 1_000,
		).length,
		latestIncidents: sorted
			.filter((event) => ["warn", "error", "fatal"].includes(event.severity))
			.slice(0, 20),
		commonFailures: [...groups.values()]
			.sort((a, b) => b.count - a.count)
			.slice(0, 10),
		slowestOperations: sorted
			.filter((event) => event.durationMs !== undefined)
			.sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
			.slice(0, 10),
	};
}
