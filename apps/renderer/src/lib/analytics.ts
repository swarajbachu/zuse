import {
	ActiveTimeTracker,
	type AnalyticsEventName,
	type AnalyticsProperties,
	isAnalyticsEventName,
	sanitizeAnalyticsProperties,
} from "@zuse/analytics";
import type { AnalyticsContext } from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";
import posthog from "posthog-js/dist/module.slim";

import { getRpcClient } from "./rpc-client.ts";

const PROJECT_KEY =
	(import.meta.env.VITE_POSTHOG_KEY as string | undefined)?.trim() ?? "";
const HOST =
	(import.meta.env.VITE_POSTHOG_HOST as string | undefined)?.trim() ||
	"https://us.i.posthog.com";
const ENABLED_FOR_BUILD =
	PROJECT_KEY.length > 0 &&
	(import.meta.env.PROD || import.meta.env.VITE_POSTHOG_ENABLE_DEV === "1");

let initialized = false;
let currentContext: AnalyticsContext | null = null;
let contextFiber: Fiber.Fiber<unknown, unknown> | null = null;
let cleanupRuntime: (() => void) | null = null;

const common = (context: AnalyticsContext) => {
	const now = new Date();
	const platform = navigator.platform.toLowerCase();
	return {
		surface: "desktop",
		os: platform.includes("mac")
			? "macos"
			: platform.includes("win")
				? "windows"
				: platform.includes("linux")
					? "linux"
					: "unknown",
		architecture: "unknown",
		app_version: import.meta.env.VITE_APP_VERSION ?? "unknown",
		release_channel: import.meta.env.MODE,
		identity_kind: context.identityKind,
		authenticated: context.identityKind === "account",
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown",
		local_hour: now.getHours(),
		local_weekday: now.getDay(),
	} as const;
};

const applyContext = (context: AnalyticsContext) => {
	const previousContext = currentContext;
	currentContext = context;
	if (!ENABLED_FOR_BUILD) return;

	if (!context.enabled && !initialized) return;

	if (!initialized) {
		posthog.init(PROJECT_KEY, {
			api_host: HOST,
			autocapture: false,
			capture_pageview: false,
			capture_pageleave: false,
			disable_session_recording: true,
			advanced_disable_feature_flags: true,
			advanced_disable_feature_flags_on_first_load: true,
			disable_surveys: true,
			disable_web_experiments: true,
			disable_external_dependency_loading: true,
			opt_out_capturing_by_default: !context.enabled,
			bootstrap: { distinctID: context.distinctId },
			persistence: "localStorage",
			before_send: (event) => {
				if (!event || typeof event.event !== "string") return null;
				if (event.event.startsWith("$")) {
					if (event.event !== "$identify") return null;
					const properties = event.properties ?? {};
					event.properties = {
						distinct_id: properties.distinct_id,
						$anon_distinct_id: properties.$anon_distinct_id,
					};
					return event;
				}
				if (!isAnalyticsEventName(event.event)) return null;
				const distinctId = event.properties?.distinct_id;
				event.properties = sanitizeAnalyticsProperties(
					event.event,
					event.properties ?? {},
				);
				if (typeof distinctId === "string")
					event.properties.distinct_id = distinctId;
				return event;
			},
		});
		initialized = true;
	}

	if (!context.enabled) {
		posthog.opt_out_capturing();
		return;
	}
	posthog.opt_in_capturing();
	if (
		previousContext?.identityKind === "account" &&
		context.identityKind === "anonymous"
	) {
		// Do not alias post-deletion/sign-out activity back to the old account.
		posthog.reset(true);
	}
	if (posthog.get_distinct_id() !== context.distinctId) {
		posthog.identify(context.distinctId);
	}
};

export const captureAnalytics = (
	event: AnalyticsEventName,
	properties: AnalyticsProperties = {},
): void => {
	const context = currentContext;
	if (!initialized || !context?.enabled) return;
	posthog.capture(
		event,
		sanitizeAnalyticsProperties(event, {
			...common(context),
			...properties,
		}),
	);
};

const installActivityTracking = () => {
	const emit = (seconds: number) => {
		if (seconds > 0)
			captureAnalytics("app active interval", { active_seconds: seconds });
	};
	const tracker = new ActiveTimeTracker({
		onInterval: ({ activeSeconds }) => emit(activeSeconds),
	});
	let active = false;
	const tick = () => tracker.tick();
	const interact = () => tracker.interact();
	const syncForeground = () => {
		const next = !document.hidden && document.hasFocus();
		if (next === active) return;
		active = next;
		if (next) tracker.foreground();
		else tracker.background();
	};
	const background = () => {
		if (active) tracker.background();
		active = false;
		captureAnalytics("app backgrounded", { active_seconds: 0 });
	};
	const control = (event: MouseEvent) => {
		const target =
			event.target instanceof Element
				? event.target.closest<HTMLElement>("[data-analytics-id]")
				: null;
		const controlId = target?.dataset.analyticsId;
		if (!controlId) return;
		captureAnalytics("control activated", {
			screen: document.body.dataset.analyticsScreen ?? "unknown",
			control: controlId,
			interaction_source: "pointer",
		});
	};
	for (const name of ["pointerdown", "keydown", "wheel"] as const) {
		window.addEventListener(name, interact, { passive: true });
	}
	document.addEventListener("visibilitychange", syncForeground);
	window.addEventListener("focus", syncForeground);
	window.addEventListener("blur", background);
	document.addEventListener("click", control);
	syncForeground();
	interact();
	const interval = window.setInterval(tick, 1_000);
	return () => {
		window.clearInterval(interval);
		tracker.background();
		for (const name of ["pointerdown", "keydown", "wheel"] as const) {
			window.removeEventListener(name, interact);
		}
		document.removeEventListener("visibilitychange", syncForeground);
		window.removeEventListener("focus", syncForeground);
		window.removeEventListener("blur", background);
		document.removeEventListener("click", control);
	};
};

export const startDesktopAnalytics = async (): Promise<() => void> => {
	const client = await getRpcClient();
	const context = await Effect.runPromise(client["analytics.getContext"]());
	applyContext(context);
	if (context.enabled)
		captureAnalytics("app opened", { launch_type: "standard" });
	cleanupRuntime = installActivityTracking();
	contextFiber = Effect.runFork(
		Stream.runForEach(client["analytics.contextChanges"](), (next) =>
			Effect.sync(() => applyContext(next)),
		),
	);
	return () => {
		cleanupRuntime?.();
		cleanupRuntime = null;
		if (contextFiber) void Effect.runPromise(Fiber.interrupt(contextFiber));
		contextFiber = null;
		if (initialized) void posthog.shutdown();
	};
};

export const trackAnalyticsScreen = (screen: string): void => {
	document.body.dataset.analyticsScreen = screen;
	captureAnalytics("screen viewed", { screen });
};
