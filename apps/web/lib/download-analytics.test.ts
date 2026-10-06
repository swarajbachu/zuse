import { afterEach, expect, it, vi } from "vitest";
import {
	captureDownloadResolution,
	downloadAnalyticsIdentity,
} from "./download-analytics";

const key = "public-key";
const identity = "019a1234-1234-7000-8000-123456789abc";
const request = (headers: Record<string, string> = {}) =>
	new Request("https://zuse.sh/download?private=secret", {
		headers: {
			cookie: `ph_${key}_posthog=${encodeURIComponent(JSON.stringify({ distinct_id: identity }))}`,
			...headers,
		},
	});
afterEach(() => vi.unstubAllGlobals());
it("only uses an existing anonymous visitor cookie and respects privacy signals", () => {
	expect(downloadAnalyticsIdentity(request(), key)).toBe(identity);
	expect(downloadAnalyticsIdentity(request({ dnt: "1" }), key)).toBeNull();
	expect(
		downloadAnalyticsIdentity(request({ "sec-gpc": "1" }), key),
	).toBeNull();
	expect(
		downloadAnalyticsIdentity(request({ purpose: "prefetch" }), key),
	).toBeNull();
	expect(
		downloadAnalyticsIdentity(request({ "next-router-prefetch": "1" }), key),
	).toBeNull();
	expect(downloadAnalyticsIdentity(request({ cookie: "bad" }), key)).toBeNull();
	expect(
		downloadAnalyticsIdentity(
			request({ cookie: `ph_${key}_posthog=%bad` }),
			key,
		),
	).toBeNull();
});
it("sends only resolution metadata and reuses the browser identity", async () => {
	const fetcher = vi.fn().mockResolvedValue(new Response());
	vi.stubGlobal("fetch", fetcher);
	await captureDownloadResolution({
		request: request(),
		key,
		host: "https://us.i.posthog.com/",
		target: "macos",
		outcome: "installer",
	});
	const payload = JSON.parse(fetcher.mock.calls[0][1].body);
	expect(payload.event).toBe("website_download_resolved");
	expect(payload.properties).toMatchObject({
		distinct_id: identity,
		surface: "website",
		analytics_schema_version: 2,
		download_target: "macos",
		download_outcome: "installer",
	});
	expect(JSON.stringify(payload)).not.toContain("private");
});
it("never sends without a cookie and swallows delivery failure", async () => {
	const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
	vi.stubGlobal("fetch", fetcher);
	await captureDownloadResolution({
		request: request({ cookie: "" }),
		key,
		host: "https://us.i.posthog.com",
		target: "macos",
		outcome: "installer",
	});
	expect(fetcher).not.toHaveBeenCalled();
	await expect(
		captureDownloadResolution({
			request: request(),
			key,
			host: "https://us.i.posthog.com",
			target: "macos",
			outcome: "installer",
		}),
	).resolves.toBeUndefined();
});
