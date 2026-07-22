import type { DiagnosticEvent } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	aggregateDiagnostics,
	filterDiagnosticEvents,
	sanitizeDiagnosticText,
	sanitizeDiagnosticValue,
} from "../../src/diagnostics/diagnostics-model.ts";

const event = (overrides: Partial<DiagnosticEvent> = {}): DiagnosticEvent => ({
	id: "diag_event_1",
	createdAt: "2026-07-22T10:00:00.000Z",
	severity: "error",
	source: "server.provider",
	category: "provider",
	message: "Provider exited",
	fingerprint: "provider-exited",
	runId: "run_1",
	recoveryStatus: "unresolved",
	...overrides,
});

describe("diagnostics model", () => {
	it("redacts credentials before diagnostic text is persisted", () => {
		expect(
			sanitizeDiagnosticText(
				"Authorization: Bearer secret-token https://example.test/path?token=hidden",
			),
		).toBe(
			"Authorization: Bearer [REDACTED] https://example.test/path?[REDACTED]",
		);
		expect(sanitizeDiagnosticText("OPENAI_API_KEY=super-secret-value")).toBe(
			"OPENAI_API_KEY=[REDACTED]",
		);
	});

	it("removes conversation, environment, path, and terminal fields from exports", () => {
		expect(
			sanitizeDiagnosticValue({
				view: "settings",
				prompt: "private conversation",
				openFile: "/private/project/secret.ts",
				env: { TOKEN: "secret" },
				terminalOutput: "secret output",
				log: "Authorization: Bearer hidden",
			}),
		).toEqual({ view: "settings", log: "Authorization: Bearer [REDACTED]" });
	});

	it("groups repeated failures and reports the latest incident", () => {
		const result = aggregateDiagnostics([
			event(),
			event({
				id: "diag_event_2",
				createdAt: "2026-07-22T10:01:00.000Z",
			}),
			event({
				id: "diag_event_3",
				severity: "warn",
				fingerprint: "slow-provider",
				message: "Provider startup was slow",
			}),
		]);

		expect(result.errorCount).toBe(2);
		expect(result.warningCount).toBe(1);
		expect(result.commonFailures[0]).toMatchObject({
			fingerprint: "provider-exited",
			count: 2,
		});
		expect(result.latestIncidents[0]?.id).toBe("diag_event_2");
	});

	it("filters by severity, source, and search text", () => {
		const events = [
			event(),
			event({
				id: "diag_event_2",
				severity: "warn",
				source: "renderer.network",
				message: "Connection retry scheduled",
			}),
		];

		expect(
			filterDiagnosticEvents(events, {
				severities: ["warn"],
				source: "renderer",
				search: "retry",
			}),
		).toEqual([events[1]]);
	});
});
