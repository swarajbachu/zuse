import { describe, expect, it } from "vitest";

import {
	getPowerInteractionMeasurements,
	recordPowerInteraction,
} from "../../src/lib/diagnostics-recorder.ts";

describe("performance interaction measurements", () => {
	it("keeps latency while removing session identifiers and unrelated actions", () => {
		const startedAt = new Date().toISOString();
		recordPowerInteraction("chat.provider-ready", 245.7);
		recordPowerInteraction("settings.opened", 12);

		const measurements = getPowerInteractionMeasurements(startedAt);

		expect(measurements).toHaveLength(1);
		expect(measurements[0]).toMatchObject({
			name: "chat.provider-ready",
			durationMs: 245.7,
		});
		expect(JSON.stringify(measurements)).not.toContain("session-secret");
	});
});
