import {
	installPublicSiteTracking,
	publicSiteAnalyticsConfig,
} from "@zuse/analytics/public-site";

const key = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
const privacySignal =
	navigator.doNotTrack === "1" ||
	(navigator as Navigator & { globalPrivacyControl?: boolean })
		.globalPrivacyControl;
if (process.env.NODE_ENV === "production" && key && !privacySignal) {
	void import("posthog-js")
		.then(({ default: posthog }) => {
			posthog.init(
				key,
				publicSiteAnalyticsConfig(
					process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
					"docs",
				),
			);
			installPublicSiteTracking(posthog, "docs");
		})
		.catch(() => {
			// Analytics must never prevent the site from loading.
		});
}
