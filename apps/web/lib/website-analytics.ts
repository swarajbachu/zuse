import type { CaptureResult, PostHogConfig } from "posthog-js";

function cleanUrl(value: unknown, originOnly = false): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		return originOnly ? url.origin : `${url.origin}${url.pathname}`;
	} catch {
		return undefined;
	}
}

export function sanitizeWebsiteEvent(event: CaptureResult | null) {
	if (!event) return null;
	for (const key of [
		"$session_entry_url",
		"$session_entry_referrer",
		"$current_url",
		"$referrer",
		"$initial_current_url",
		"$initial_referrer",
		"$prev_pageview_pathname",
	]) {
		if (key in event.properties) {
			event.properties[key] =
				key === "$prev_pageview_pathname"
					? String(event.properties[key]).split(/[?#]/)[0]
					: cleanUrl(event.properties[key], key.includes("referrer"));
		}
	}
	for (const key of Object.keys(event.properties)) {
		if (
			/^(\$(initial_|session_entry_)?)?(utm_|gclid|fbclid|msclkid|search_keyword)/.test(
				key,
			) ||
			key === "$set" ||
			key === "$set_once"
		) {
			delete event.properties[key];
		}
	}
	event.properties.surface = "website";
	return event;
}

export function websiteAnalyticsConfig(
	apiHost: string,
): Partial<PostHogConfig> {
	return {
		api_host: apiHost,
		capture_pageview: "history_change",
		capture_pageleave: true,
		autocapture: false,
		capture_heatmaps: false,
		capture_dead_clicks: false,
		disable_surveys: true,
		disable_external_dependency_loading: true,
		advanced_disable_feature_flags: true,
		capture_performance: false,
		disable_session_recording: true,
		person_profiles: "never",
		persistence: "memory",
		disable_persistence: true,
		respect_dnt: true,
		before_send: sanitizeWebsiteEvent,
	};
}
