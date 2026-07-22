import {
	ActiveTimeTracker,
	type AnalyticsEventName,
	type AnalyticsProperties,
	analyticsAccountId,
	createAnonymousAnalyticsId,
	isAnalyticsEventName,
	sanitizeAnalyticsProperties,
} from "@zuse/analytics";
import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import { getCalendars } from "expo-localization";
import * as SecureStore from "expo-secure-store";
import PostHog, { PostHogPersistedProperty } from "posthog-react-native";
import { AppState, Platform } from "react-native";

const ENABLED_KEY = "zuse.mobile.analytics.enabled.v1";
const ANONYMOUS_ID_KEY = "zuse.mobile.analytics.anonymous-id.v1";
const IDENTITY_KIND_KEY = "zuse.mobile.analytics.identity-kind.v1";
const PROJECT_KEY = (process.env.EXPO_PUBLIC_POSTHOG_KEY ?? "").trim();
const HOST = (
	process.env.EXPO_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com"
).trim();
const ENABLED_FOR_BUILD =
	PROJECT_KEY.length > 0 &&
	(!__DEV__ || process.env.EXPO_PUBLIC_POSTHOG_ENABLE_DEV === "1");

let client: PostHog | null = null;
let enabled = true;
let distinctId = "";
let identityKind: "anonymous" | "account" = "anonymous";
let currentScreen = "unknown";
let activityCleanup: (() => void) | null = null;
let activeTracker: ActiveTimeTracker | null = null;

const anonymousId = async (rotate = false): Promise<string> => {
	if (!rotate) {
		const existing = await SecureStore.getItemAsync(ANONYMOUS_ID_KEY);
		if (existing?.startsWith("anonymous_")) return existing;
	}
	const next = createAnonymousAnalyticsId(Crypto.randomUUID);
	await SecureStore.setItemAsync(ANONYMOUS_ID_KEY, next);
	return next;
};

const makeClient = (): PostHog | null => {
	if (!ENABLED_FOR_BUILD || !enabled) return null;
	if (client) return client;
	client = new PostHog(PROJECT_KEY, {
		host: HOST,
		persistence: "file",
		captureAppLifecycleEvents: false,
		enableSessionReplay: false,
		disableRemoteFeatureFlags: true,
		disableRemoteConfig: true,
		preloadFeatureFlags: false,
		setDefaultPersonProperties: false,
		before_send: (event) => {
			if (!event || typeof event.event !== "string") return null;
			if (event.event.startsWith("$")) {
				if (event.event !== "$identify") return null;
				const properties = event.properties ?? {};
				const identifyProperties: Record<string, string> = {};
				if (typeof properties.distinct_id === "string")
					identifyProperties.distinct_id = properties.distinct_id;
				if (typeof properties.$anon_distinct_id === "string")
					identifyProperties.$anon_distinct_id = properties.$anon_distinct_id;
				return {
					...event,
					$set: undefined,
					$set_once: undefined,
					properties: identifyProperties,
				};
			}
			if (!isAnalyticsEventName(event.event)) return null;
			const eventDistinctId = event.properties?.distinct_id;
			const properties = sanitizeAnalyticsProperties(
				event.event,
				event.properties ?? {},
			);
			if (typeof eventDistinctId === "string")
				properties.distinct_id = eventDistinctId;
			return { ...event, $set: undefined, $set_once: undefined, properties };
		},
		customAppProperties: (properties) => ({
			...properties,
			$device_name: null,
			$device_model: null,
			$device_manufacturer: null,
			$locale: null,
		}),
	});
	client.identify(distinctId);
	return client;
};

const common = () => {
	const now = new Date();
	return {
		surface: Platform.OS === "ios" ? "ios" : "android",
		os: `${Platform.OS}-${Platform.Version}`,
		architecture: "unknown",
		app_version: Application.nativeApplicationVersion ?? "unknown",
		release_channel: String(
			Constants.expoConfig?.extra?.releaseChannel ?? "production",
		),
		identity_kind: identityKind,
		authenticated: identityKind === "account",
		timezone: getCalendars()[0]?.timeZone ?? "unknown",
		local_hour: now.getHours(),
		local_weekday: now.getDay(),
	} as const;
};

export const captureMobileAnalytics = (
	event: AnalyticsEventName,
	properties: AnalyticsProperties = {},
): void => {
	if (!enabled) return;
	makeClient()?.capture(
		event,
		sanitizeAnalyticsProperties(event, { ...common(), ...properties }),
	);
};

const installActivityTracking = () => {
	const tracker = new ActiveTimeTracker({
		onInterval: ({ activeSeconds }) =>
			captureMobileAnalytics("app active interval", {
				active_seconds: activeSeconds,
			}),
	});
	activeTracker = tracker;
	if (AppState.currentState === "active") tracker.foreground();
	const subscription = AppState.addEventListener("change", (state) => {
		if (state === "active") tracker.foreground();
		else {
			tracker.background();
			captureMobileAnalytics("app backgrounded", { active_seconds: 0 });
		}
	});
	const timer = setInterval(() => tracker.tick(), 1_000);
	return () => {
		clearInterval(timer);
		tracker.background();
		if (activeTracker === tracker) activeTracker = null;
		subscription.remove();
	};
};

export const hydrateMobileAnalytics = async (
	accountId: string | null,
): Promise<boolean> => {
	const storedEnabled = await SecureStore.getItemAsync(ENABLED_KEY);
	enabled = storedEnabled === null ? true : storedEnabled === "true";
	const previousKind = await SecureStore.getItemAsync(IDENTITY_KIND_KEY);
	if (accountId) {
		distinctId = analyticsAccountId(accountId);
		identityKind = "account";
	} else {
		distinctId = await anonymousId(previousKind === "account");
		identityKind = "anonymous";
	}
	await SecureStore.setItemAsync(IDENTITY_KIND_KEY, identityKind);
	if (enabled) {
		makeClient();
		captureMobileAnalytics("app opened", { launch_type: "standard" });
	}
	activityCleanup?.();
	activityCleanup = installActivityTracking();
	return enabled;
};

export const setMobileAnalyticsEnabled = async (
	next: boolean,
): Promise<void> => {
	enabled = next;
	await SecureStore.setItemAsync(ENABLED_KEY, String(next));
	if (next) {
		const instance = makeClient();
		await instance?.optIn();
	} else if (client) {
		await client.optOut();
		client.setPersistedProperty(PostHogPersistedProperty.Queue, null);
		await client.shutdown(1_000);
		client = null;
	}
};

export const setMobileAnalyticsAccount = async (
	accountId: string | null,
): Promise<void> => {
	const nextKind = accountId ? "account" : "anonymous";
	if (
		nextKind === identityKind &&
		(accountId === null || distinctId === analyticsAccountId(accountId))
	) {
		return;
	}
	identityKind = nextKind;
	distinctId = accountId
		? analyticsAccountId(accountId)
		: await anonymousId(true);
	await SecureStore.setItemAsync(IDENTITY_KIND_KEY, identityKind);
	if (client) {
		client.reset();
		client.identify(distinctId);
	}
};

export const resetMobileAnalyticsIdentity = async (): Promise<void> => {
	identityKind = "anonymous";
	distinctId = await anonymousId(true);
	await SecureStore.setItemAsync(IDENTITY_KIND_KEY, identityKind);
	if (client) {
		client.reset();
		client.identify(distinctId);
	}
};

export const noteMobileInteraction = (): void => {
	activeTracker?.interact();
};

export const trackMobileScreen = (screen: string): void => {
	if (screen === currentScreen) return;
	currentScreen = screen;
	captureMobileAnalytics("screen viewed", { screen });
};

export const captureMobileControl = (control: string): void => {
	captureMobileAnalytics("control activated", {
		screen: currentScreen,
		control,
		interaction_source: "touch",
	});
};
