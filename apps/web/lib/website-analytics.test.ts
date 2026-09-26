import { describe, expect, it } from "vitest";
import {
	sanitizeWebsiteEvent,
	websiteAnalyticsConfig,
} from "./website-analytics";

describe("website analytics", () => {
	it("removes query strings, fragments, attribution IDs, and profile updates", () => {
		const event = sanitizeWebsiteEvent({
			uuid: "019a1234-1234-7000-8000-123456789abc",
			event: "$pageview",
			properties: {
				$current_url: "https://zuse.sh/blog?token=secret#private",
				$referrer: "https://search.example/private?q=secret",
				$prev_pageview_pathname: "/blog?token=secret",
				utm_source: "private",
				$session_entry_url: "https://zuse.sh/?secret=yes",
				$session_entry_referrer: "https://search.example/find?q=private",
				$session_entry_utm_term: "private",
				$search_keyword: "private",
				$initial_gclid: "private",
				$set: { email: "private" },
				$set_once: { url: "private" },
			},
		});
		expect(event?.properties).toEqual({
			$current_url: "https://zuse.sh/blog",
			$referrer: "https://search.example",
			$prev_pageview_pathname: "/blog",
			surface: "website",
			$session_entry_url: "https://zuse.sh/",
			$session_entry_referrer: "https://search.example",
		});
	});
	it("preserves rejected events and discards malformed URLs", () => {
		expect(sanitizeWebsiteEvent(null)).toBeNull();
		expect(
			sanitizeWebsiteEvent({
				uuid: "019a1234-1234-7000-8000-123456789abc",
				event: "$pageview",
				properties: { $referrer: "invalid" },
			})?.properties.$referrer,
		).toBeUndefined();
	});
	it("tracks client navigation without replay, profiles, or persistent storage", () => {
		expect(websiteAnalyticsConfig("https://eu.i.posthog.com")).toMatchObject({
			api_host: "https://eu.i.posthog.com",
			capture_pageview: "history_change",
			autocapture: false,
			disable_session_recording: true,
			person_profiles: "never",
			persistence: "memory",
			disable_persistence: true,
			respect_dnt: true,
		});
	});
});
