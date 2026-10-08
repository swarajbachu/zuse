import { useLayoutEffect } from "react";

import {
	applyResolvedAppearance,
	LAST_APPEARANCE_MODE_KEY,
	type ResolvedAppearance,
	useAppearanceForMode,
} from "./appearance-mode.tsx";
import { useSettingsStore } from "./settings-client-bus.ts";

export function useResolvedAppearance(): ResolvedAppearance {
	return useAppearanceForMode(useSettingsStore((s) => s.appearanceMode));
}

export function AppearanceController() {
	const appearanceMode = useSettingsStore((s) => s.appearanceMode);
	const resolvedAppearance = useAppearanceForMode(appearanceMode);

	useLayoutEffect(() => {
		applyResolvedAppearance(resolvedAppearance);
		try {
			window.localStorage.setItem(LAST_APPEARANCE_MODE_KEY, appearanceMode);
		} catch {
			// Storage can be unavailable in private windows; the theme still applies.
		}
		window.zuse?.window?.setAppearanceMode?.(appearanceMode);
		window.dispatchEvent(
			new CustomEvent("zuse:appearance-change", {
				detail: { mode: appearanceMode, resolved: resolvedAppearance },
			}),
		);
	}, [appearanceMode, resolvedAppearance]);

	return null;
}
