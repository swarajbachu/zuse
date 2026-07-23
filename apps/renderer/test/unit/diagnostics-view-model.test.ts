import type { DiagnosticEvent } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	DEFAULT_DIAGNOSTICS_PREFERENCES,
	groupDiagnosticEvents,
	parseDiagnosticsPreferences,
	relatedDiagnosticEvents,
} from "../../src/lib/diagnostics-view-model.ts";

const event = (
	id: string,
	fingerprint: string,
	createdAt: string,
	severity: DiagnosticEvent["severity"] = "error",
): DiagnosticEvent => ({
	id,
	createdAt,
	severity,
	source: "provider.stream",
	category: "provider",
	message: `Failure ${id}`,
	fingerprint,
	runId: "run-1",
	recoveryStatus: "unresolved",
});

describe("diagnostics view model", () => {
	it("falls back safely for missing or corrupted preferences", () => {
		expect(parseDiagnosticsPreferences(null)).toEqual(
			DEFAULT_DIAGNOSTICS_PREFERENCES,
		);
		expect(parseDiagnosticsPreferences("{nope")).toEqual(
			DEFAULT_DIAGNOSTICS_PREFERENCES,
		);
		expect(
			parseDiagnosticsPreferences(
				JSON.stringify({ view: "unknown", rangeMs: 42, severity: "loud" }),
			),
		).toEqual(DEFAULT_DIAGNOSTICS_PREFERENCES);
	});

	it("restores valid preferences without trusting invalid fields", () => {
		expect(
			parseDiagnosticsPreferences(
				JSON.stringify({
					view: "performance",
					rangeMs: 3_600_000,
					severity: "warn",
					source: "server",
					search: "timeout",
				}),
			),
		).toEqual({
			view: "performance",
			rangeMs: 3_600_000,
			severity: "warn",
			source: "server",
			search: "timeout",
		});
	});

	it("restores the live logs view", () => {
		expect(
			parseDiagnosticsPreferences(
				JSON.stringify({
					view: "logs",
					rangeMs: 86_400_000,
					severity: "all",
					source: "",
					search: "",
				}),
			).view,
		).toBe("logs");
	});

	it("groups repeated failures and preserves the newest representative", () => {
		const grouped = groupDiagnosticEvents(
			[
				event("old", "same", "2026-07-22T10:00:00.000Z"),
				event("other", "other", "2026-07-22T11:00:00.000Z", "warn"),
				event("new", "same", "2026-07-22T12:00:00.000Z", "fatal"),
			],
			new Map([["same", 8]]),
		);

		expect(grouped.map((item) => item.event.id)).toEqual(["new", "other"]);
		expect(grouped[0]?.occurrences).toBe(8);
	});

	it("returns related occurrences newest first", () => {
		const related = relatedDiagnosticEvents(
			[
				event("old", "same", "2026-07-22T10:00:00.000Z"),
				event("other", "other", "2026-07-22T11:00:00.000Z"),
				event("new", "same", "2026-07-22T12:00:00.000Z"),
			],
			"same",
		);
		expect(related.map((item) => item.id)).toEqual(["new", "old"]);
	});
});
