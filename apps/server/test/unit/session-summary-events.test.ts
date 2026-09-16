import { describe, expect, it } from "vitest";
import { sessionSummaryEvents } from "../../src/provider/session-summary-events.ts";

describe("session summary notifications", () => {
	it("refreshes catalog status on turn start and settlement without opening a transcript", () => {
		expect(sessionSummaryEvents.has("TurnStarted")).toBe(true);
		expect(sessionSummaryEvents.has("TurnSettled")).toBe(true);
	});
	it("does not refresh the catalog for every transcript delta", () => {
		expect(sessionSummaryEvents.has("MessagePersisted")).toBe(false);
	});
});
