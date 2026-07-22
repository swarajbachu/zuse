import { useEffect } from "react";

import { setMobileAnalyticsAccount, trackMobileScreen } from "~/lib/analytics";
import { mobileAnalyticsScreen } from "~/lib/mobile-analytics-screen";
import { useAnalyticsStore } from "~/store/analytics";
import { useAuthStore } from "~/store/auth";

export const useMobileAnalytics = (pathname: string): void => {
	const accountId = useAuthStore((state) => state.account?.id ?? null);
	const authHydrated = useAuthStore((state) => state.hydrated);
	const hydrateAuth = useAuthStore((state) => state.hydrate);
	const analyticsHydrated = useAnalyticsStore((state) => state.hydrated);
	const hydrateAnalytics = useAnalyticsStore((state) => state.hydrate);

	useEffect(() => {
		if (!authHydrated) void hydrateAuth();
	}, [authHydrated, hydrateAuth]);

	useEffect(() => {
		if (authHydrated && !analyticsHydrated) void hydrateAnalytics();
	}, [analyticsHydrated, authHydrated, hydrateAnalytics]);

	useEffect(() => {
		if (analyticsHydrated) void setMobileAnalyticsAccount(accountId);
	}, [accountId, analyticsHydrated]);

	useEffect(() => {
		if (analyticsHydrated) {
			trackMobileScreen(mobileAnalyticsScreen(pathname));
		}
	}, [analyticsHydrated, pathname]);
};
