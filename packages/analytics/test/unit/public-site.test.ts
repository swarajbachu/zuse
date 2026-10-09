import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	classifyPublicLink,
	installPublicSiteTracking,
	publicSiteAnalyticsConfig,
	sanitizePublicSiteEvent,
} from "../../src/public-site.ts";

it("classifies downloads and docs without recording queries or external URLs", () => {
	expect(
		classifyPublicLink(
			"/download?platform=linux&format=deb&token=secret",
			"https://zuse.sh",
			"website",
		),
	).toEqual({
		event: "website_download_clicked",
		properties: { destination: "/download", download_target: "linux-deb" },
	});
	expect(
		classifyPublicLink(
			"https://docs.zuse.sh/start?search=private#secret",
			"https://zuse.sh",
			"website",
		),
	).toEqual({
		event: "website_docs_clicked",
		properties: { destination: "/start" },
	});
	expect(
		classifyPublicLink("/docs/reference", "https://zuse.sh", "website")?.event,
	).toBe("website_docs_clicked");
	expect(
		classifyPublicLink(
			"https://github.com/swarajbachu/zuse/releases/download/v1/Zuse.dmg",
			"https://zuse.sh",
			"website",
		)?.properties.download_target,
	).toBe("macos");
	expect(
		classifyPublicLink(
			"https://external.example/download",
			"https://zuse.sh",
			"website",
		),
	).toBeNull();
	expect(
		classifyPublicLink("javascript:alert(1)", "https://zuse.sh", "website"),
	).toBeNull();
});
it("labels docs events and disables invasive collection", () => {
	const event = {
		event: "$pageview",
		uuid: "test",
		properties: {
			$current_url: "https://docs.zuse.sh/start?key=private#secret",
			utm_term: "private",
			$set: { email: "private" },
		},
	};
	expect(sanitizePublicSiteEvent(event, "docs")?.properties).toEqual({
		$current_url: "https://docs.zuse.sh/start",
		surface: "docs",
		analytics_schema_version: 2,
	});
	expect(
		publicSiteAnalyticsConfig("https://us.i.posthog.com", "docs"),
	).toMatchObject({
		persistence: "cookie",
		cookie_expiration: 90,
		cross_subdomain_cookie: true,
		person_profiles: "never",
		autocapture: false,
		disable_session_recording: true,
	});
});

describe("active docs reading", () => {
	let win: EventTarget;
	let doc: EventTarget & {
		hidden: boolean;
		hasFocus: () => boolean;
		documentElement: { scrollHeight: number };
	};
	let page: { pathname: string; origin: string };
	let capture: ReturnType<
		typeof vi.fn<import("posthog-js").PostHog["capture"]>
	>;
	let cleanup: () => void;
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(100_000);
		win = new EventTarget();
		Object.assign(win, {
			innerHeight: 500,
			scrollY: 500,
			setInterval,
			clearInterval,
		});
		doc = Object.assign(new EventTarget(), {
			hidden: false,
			hasFocus: () => true,
			documentElement: { scrollHeight: 1500 },
		});
		page = { pathname: "/start", origin: "https://docs.zuse.sh" };
		vi.stubGlobal("window", win);
		vi.stubGlobal("document", doc);
		vi.stubGlobal("location", page);
		capture = vi.fn<import("posthog-js").PostHog["capture"]>();
		cleanup = installPublicSiteTracking({ capture }, "docs");
	});
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});
	it("requires active time plus scroll and emits once per visit", () => {
		vi.advanceTimersByTime(30_000);
		expect(capture).not.toHaveBeenCalled();
		win.dispatchEvent(new Event("scroll"));
		expect(capture).toHaveBeenCalledWith(
			"docs_page_engaged",
			expect.objectContaining({
				page_path: "/start",
				active_seconds: 30,
				scroll_percent: 50,
			}),
		);
		vi.advanceTimersByTime(20_000);
		win.dispatchEvent(new Event("scroll"));
		expect(capture).toHaveBeenCalledTimes(1);
	});
	it("excludes background time and resets on client navigation", () => {
		win.dispatchEvent(new Event("scroll"));
		vi.advanceTimersByTime(10_000);
		doc.hidden = true;
		doc.dispatchEvent(new Event("visibilitychange"));
		vi.advanceTimersByTime(40_000);
		expect(capture).not.toHaveBeenCalled();
		doc.hidden = false;
		doc.dispatchEvent(new Event("visibilitychange"));
		vi.advanceTimersByTime(20_000);
		expect(capture).toHaveBeenCalledTimes(1);
		page.pathname = "/reference";
		win.dispatchEvent(new Event("scroll"));
		vi.advanceTimersByTime(30_000);
		expect(capture).toHaveBeenCalledTimes(2);
		expect(capture.mock.calls[1]?.[1]?.page_path).toBe("/reference");
	});
	it("does not count indefinitely idle tabs", () => {
		vi.advanceTimersByTime(120_000);
		win.dispatchEvent(new Event("scroll"));
		expect(capture.mock.calls[0]?.[1]?.active_seconds).toBe(60);
	});
});
