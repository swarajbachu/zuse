import { create } from "zustand";

import {
	hydrateMobileAnalytics,
	setMobileAnalyticsEnabled,
} from "~/lib/analytics";
import { useAuthStore } from "./auth";

interface AnalyticsState {
	readonly enabled: boolean;
	readonly hydrated: boolean;
	readonly hydrate: () => Promise<void>;
	readonly setEnabled: (enabled: boolean) => Promise<void>;
}

export const useAnalyticsStore = create<AnalyticsState>((set, get) => ({
	enabled: true,
	hydrated: false,
	hydrate: async () => {
		if (get().hydrated) return;
		const accountId = useAuthStore.getState().account?.id ?? null;
		const enabled = await hydrateMobileAnalytics(accountId);
		set({ enabled, hydrated: true });
	},
	setEnabled: async (enabled) => {
		set({ enabled });
		await setMobileAnalyticsEnabled(enabled);
	},
}));
