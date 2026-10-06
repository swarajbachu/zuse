import type { CaptureResult, PostHogConfig } from "posthog-js";
import { ActiveTimeTracker } from "./active-time.ts";

export type PublicSiteSurface = "website" | "docs";

function cleanUrl(value: unknown, originOnly = false): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		return originOnly ? url.origin : `${url.origin}${url.pathname}`;
	} catch {
		return undefined;
	}
}

export function sanitizePublicSiteEvent(
	event: CaptureResult | null,
	surface: PublicSiteSurface = "website",
) {
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
	event.properties.surface = surface;
	event.properties.analytics_schema_version = 2;
	return event;
}

export function publicSiteAnalyticsConfig(
	apiHost: string,
	surface: PublicSiteSurface = "website",
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
		advanced_disable_feature_flags_on_first_load: true,
		disable_web_experiments: true,
		rageclick: false,
		capture_performance: false,
		disable_session_recording: true,
		person_profiles: "never",
		persistence: "cookie",
		cross_subdomain_cookie: true,
		cookie_expiration: 90,
		secure_cookie: true,
		disable_persistence: false,
		respect_dnt: true,
		before_send: (event) => sanitizePublicSiteEvent(event, surface),
	};
}

export type PublicLinkEvent = {
	event:
		| "website_download_clicked"
		| "website_docs_clicked"
		| "website_cta_clicked"
		| "docs_link_clicked";
	properties: Record<string, string>;
};

export function classifyPublicLink(
	href: string,
	origin: string,
	surface: PublicSiteSurface,
): PublicLinkEvent | null {
	let url: URL;
	try {
		url = new URL(href, origin);
	} catch {
		return null;
	}
	if (!["http:", "https:"].includes(url.protocol)) return null;
	const ownSite =
		url.origin === origin || ["zuse.sh", "www.zuse.sh"].includes(url.hostname);
	const installer =
		url.hostname === "github.com" &&
		/^\/swarajbachu\/zuse\/releases\/download\//.test(url.pathname) &&
		/\.(dmg|appimage|deb)$/i.test(url.pathname);
	if ((ownSite && url.pathname === "/download") || installer) {
		const platform = url.searchParams.get("platform");
		return {
			event: "website_download_clicked",
			properties: {
				destination: "/download",
				download_target: installer
					? /\.dmg$/i.test(url.pathname)
						? "macos"
						: /\.deb$/i.test(url.pathname)
							? "linux-deb"
							: "linux-appimage"
					: ["mac", "macos", "darwin"].includes(platform ?? "")
						? "macos"
						: platform === "linux"
							? url.searchParams.get("format") === "deb"
								? "linux-deb"
								: "linux-appimage"
							: "auto",
			},
		};
	}
	if (
		surface === "website" &&
		(url.hostname === "docs.zuse.sh" ||
			(ownSite && /^\/docs(?:\/|$)/.test(url.pathname)))
	) {
		return {
			event: "website_docs_clicked",
			properties: { destination: url.pathname },
		};
	}
	if (ownSite && url.pathname === "/pricing")
		return {
			event: "website_cta_clicked",
			properties: { destination: "/pricing" },
		};
	if (surface === "docs" && url.origin === origin)
		return {
			event: "docs_link_clicked",
			properties: { destination: url.pathname },
		};
	return null;
}

// Only public page paths and stable categories are recorded; never link text or search input.
export function installPublicSiteTracking(
	sdk: Pick<import("posthog-js").PostHog, "capture">,
	surface: PublicSiteSurface,
): () => void {
	let path = location.pathname;
	let activeSeconds = 0;
	let maxScroll = 0;
	let engaged = false;
	let foreground = false;
	const emitEngaged = () => {
		if (engaged || activeSeconds < 30 || (surface === "docs" && maxScroll < 50))
			return;
		engaged = true;
		sdk.capture(
			surface === "docs" ? "docs_page_engaged" : "website_page_engaged",
			{
				page_path: path,
				active_seconds: activeSeconds,
				scroll_percent: maxScroll,
			},
		);
	};
	const tracker = new ActiveTimeTracker({
		flushAfterMs: 5_000,
		onInterval: (interval) => {
			activeSeconds += interval.activeSeconds;
			emitEngaged();
		},
	});
	const resetPage = () => {
		if (path === location.pathname) return;
		tracker.tick();
		tracker.flush();
		if (foreground) tracker.foreground();
		path = location.pathname;
		activeSeconds = 0;
		maxScroll = 0;
		engaged = false;
	};
	const sync = () => {
		const next = !document.hidden && document.hasFocus();
		if (next === foreground) return;
		foreground = next;
		if (next) tracker.foreground();
		else tracker.background();
	};
	const interact = () => {
		resetPage();
		tracker.interact();
	};
	const scroll = () => {
		interact();
		const height = document.documentElement.scrollHeight - window.innerHeight;
		maxScroll = Math.max(
			maxScroll,
			height <= 0
				? 100
				: Math.min(100, Math.round((window.scrollY / height) * 100)),
		);
		emitEngaged();
	};
	const click = (event: MouseEvent) => {
		if (!(event.target instanceof Element)) return;
		const link = event.target.closest<HTMLAnchorElement>("a[href]");
		if (!link) return;
		const classified = classifyPublicLink(link.href, location.origin, surface);
		if (!classified) return;
		const placement = link.closest("header, nav")
			? "navigation"
			: link.closest("footer")
				? "footer"
				: "content";
		sdk.capture(
			classified.event,
			{ ...classified.properties, page_path: location.pathname, placement },
			{ transport: "sendBeacon" },
		);
	};
	document.addEventListener("click", click);
	document.addEventListener("visibilitychange", sync);
	window.addEventListener("focus", sync);
	window.addEventListener("blur", sync);
	for (const name of ["pointerdown", "keydown"] as const)
		window.addEventListener(name, interact, { passive: true });
	window.addEventListener("scroll", scroll, { passive: true });
	sync();
	const timer = window.setInterval(() => {
		tracker.tick();
		resetPage();
		sync();
	}, 1_000);
	return () => {
		window.clearInterval(timer);
		tracker.background();
		document.removeEventListener("click", click);
		document.removeEventListener("visibilitychange", sync);
		window.removeEventListener("focus", sync);
		window.removeEventListener("blur", sync);
		for (const name of ["pointerdown", "keydown"] as const)
			window.removeEventListener(name, interact);
		window.removeEventListener("scroll", scroll);
	};
}
