import { websiteAnalyticsConfig } from "@/lib/website-analytics";

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
				websiteAnalyticsConfig(
					process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
				),
			);
			document.addEventListener("click", (event) => {
				if (!(event.target instanceof Element)) return;
				const link = event.target.closest<HTMLAnchorElement>("a[href]");
				if (!link) return;
				const url = new URL(link.href, location.origin);
				if (
					url.origin === location.origin &&
					["/download", "/pricing"].includes(url.pathname)
				) {
					posthog.capture("website_cta_clicked", { destination: url.pathname });
				}
			});
		})
		.catch(() => {
			// Analytics must never prevent the website from loading.
		});
}
