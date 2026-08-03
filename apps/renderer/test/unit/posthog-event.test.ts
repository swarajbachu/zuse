import { describe, expect, it } from "vitest";

import { sanitizePostHogEvent } from "../../src/lib/posthog-event.ts";

describe("PostHog event privacy boundary", () => {
	it("preserves required ingest metadata while removing unsafe properties", () => {
		const event = sanitizePostHogEvent({
			event: "app opened",
			properties: {
				token: "public-ingest-token",
				distinct_id: "anonymous_test",
				launch_type: "standard",
				prompt: "must not leave the app",
			},
		});

		expect(event?.properties).toMatchObject({
			token: "public-ingest-token",
			distinct_id: "anonymous_test",
			launch_type: "standard",
			analytics_schema_version: 2,
		});
		expect(event?.properties).not.toHaveProperty("prompt");
	});

	it("keeps identify ingestion metadata without leaking profile properties", () => {
		const event = sanitizePostHogEvent({
			event: "$identify",
			properties: {
				token: "public-ingest-token",
				distinct_id: "account_test",
				$anon_distinct_id: "anonymous_test",
				email: "private@example.com",
			},
		});

		expect(event?.properties).toEqual({
			token: "public-ingest-token",
			distinct_id: "account_test",
			$anon_distinct_id: "anonymous_test",
		});
	});
});
