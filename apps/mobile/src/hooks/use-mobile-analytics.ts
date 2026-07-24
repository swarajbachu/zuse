import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { setMobileAnalyticsAccount, trackMobileScreen } from "~/lib/analytics";
import { mobileAnalyticsScreen } from "~/lib/mobile-analytics-screen";
import { analyticsHydratedAtom, hydrateAnalytics } from "~/store/analytics";
import { authAccountAtom, authHydratedAtom, hydrateAuth } from "~/store/auth";

export const useMobileAnalytics = (pathname: string): void => {
	const account = useAtomValue(authAccountAtom);
	const accountId = account?.id ?? null;
	const authHydrated = useAtomValue(authHydratedAtom);
	const analyticsHydrated = useAtomValue(analyticsHydratedAtom);

	useEffect(() => {
		if (!authHydrated) void hydrateAuth();
	}, [authHydrated]);

	useEffect(() => {
		if (authHydrated && !analyticsHydrated) void hydrateAnalytics();
	}, [analyticsHydrated, authHydrated]);

	useEffect(() => {
		if (analyticsHydrated) void setMobileAnalyticsAccount(accountId);
	}, [accountId, analyticsHydrated]);

	useEffect(() => {
		if (analyticsHydrated) {
			trackMobileScreen(mobileAnalyticsScreen(pathname));
		}
	}, [analyticsHydrated, pathname]);
};
