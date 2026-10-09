/**
 * Theme resolution that does not depend on settings, so screens rendered before
 * settings load can import it without pulling in the settings client.
 */
import { AppearanceMode } from "@zuse/contracts";
import { Schema } from "effect";
import {
	useLayoutEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";

export type ResolvedAppearance = "light" | "dark";

const subscribeSystemAppearance = (onStoreChange: () => void): (() => void) => {
	if (
		typeof window === "undefined" ||
		typeof window.matchMedia !== "function"
	) {
		return () => {};
	}
	const media = window.matchMedia("(prefers-color-scheme: dark)");
	media.addEventListener("change", onStoreChange);
	return () => media.removeEventListener("change", onStoreChange);
};

const getSystemAppearance = (): ResolvedAppearance => {
	if (
		typeof window === "undefined" ||
		typeof window.matchMedia !== "function"
	) {
		return "dark";
	}
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
};

export const resolveAppearance = (
	mode: AppearanceMode,
	systemAppearance: ResolvedAppearance,
): ResolvedAppearance => (mode === "system" ? systemAppearance : mode);

export const LAST_APPEARANCE_MODE_KEY = "zuse.appearance.lastMode";
const isAppearanceMode = Schema.is(AppearanceMode);

/**
 * The appearance chosen in the last session that loaded settings. Screens
 * shown before settings exist (sign-in, pairing) use it so they open in the
 * user's theme instead of the browser default.
 */
const lastAppearanceMode = (): AppearanceMode => {
	try {
		const stored = window.localStorage.getItem(LAST_APPEARANCE_MODE_KEY);
		return isAppearanceMode(stored) ? stored : "system";
	} catch {
		return "system";
	}
};

export const useAppearanceForMode = (
	appearanceMode: AppearanceMode,
): ResolvedAppearance => {
	const systemAppearance = useSyncExternalStore(
		subscribeSystemAppearance,
		getSystemAppearance,
		(): ResolvedAppearance => "dark",
	);
	return useMemo(
		() => resolveAppearance(appearanceMode, systemAppearance),
		[appearanceMode, systemAppearance],
	);
};

export const applyResolvedAppearance = (resolved: ResolvedAppearance): void => {
	const root = document.documentElement;
	root.classList.toggle("dark", resolved === "dark");
	root.style.colorScheme = resolved;
};

/** Applies the last known appearance without subscribing to settings. */
export function PreSettingsAppearanceController() {
	const [appearanceMode] = useState(lastAppearanceMode);
	const resolvedAppearance = useAppearanceForMode(appearanceMode);
	useLayoutEffect(() => {
		applyResolvedAppearance(resolvedAppearance);
	}, [resolvedAppearance]);
	return null;
}
