import type { AppearanceMode } from "@zuse/contracts";
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useExtensionContributions } from "./extension-registry.tsx";
import { useSettingsStore } from "./settings-client-bus.ts";

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

export function useResolvedAppearance(): ResolvedAppearance {
	const appearanceMode = useSettingsStore((s) => s.appearanceMode);
	const themeSelection = useSettingsStore((s) => s.themeSelection);
	const extensions = useExtensionContributions();
	const systemAppearance = useSyncExternalStore(
		subscribeSystemAppearance,
		getSystemAppearance,
		(): ResolvedAppearance => "dark",
	);
	return useMemo(() => {
		if (themeSelection._tag === "extension") {
			const theme = extensions
				.find(
					(extension) => extension.extensionId === themeSelection.extensionId,
				)
				?.contributions.themes.find(
					(candidate) => candidate.id === themeSelection.themeId,
				);
			return theme?.appearance ?? systemAppearance;
		}
		return resolveAppearance(
			themeSelection.appearance ?? appearanceMode,
			systemAppearance,
		);
	}, [appearanceMode, extensions, systemAppearance, themeSelection]);
}

export function AppearanceController() {
	const appearanceMode = useSettingsStore((s) => s.appearanceMode);
	const themeSelection = useSettingsStore((s) => s.themeSelection);
	const extensions = useExtensionContributions();
	const resolvedAppearance = useResolvedAppearance();

	useLayoutEffect(() => {
		const root = document.documentElement;
		const selectedTheme =
			themeSelection._tag === "extension"
				? extensions
						.find(
							(extension) =>
								extension.extensionId === themeSelection.extensionId,
						)
						?.contributions.themes.find(
							(theme) => theme.id === themeSelection.themeId,
						)
				: undefined;
		const tokenMap = {
			background: "--background",
			foreground: "--foreground",
			card: "--card",
			cardForeground: "--card-foreground",
			popover: "--popover",
			popoverForeground: "--popover-foreground",
			muted: "--muted",
			mutedForeground: "--muted-foreground",
			border: "--border",
			input: "--input",
			accent: "--accent",
			accentForeground: "--accent-foreground",
			destructive: "--destructive",
			ring: "--ring",
		} as const;
		for (const [key, token] of Object.entries(tokenMap)) {
			const value = selectedTheme?.theme.colors[key as keyof typeof tokenMap];
			if (value === undefined) root.style.removeProperty(token);
			else root.style.setProperty(token, value);
		}
		root.classList.toggle("dark", resolvedAppearance === "dark");
		root.style.colorScheme = resolvedAppearance;
		window.zuse?.window?.setAppearanceMode?.(appearanceMode);
		window.dispatchEvent(
			new CustomEvent("zuse:appearance-change", {
				detail: { mode: appearanceMode, resolved: resolvedAppearance },
			}),
		);
	}, [appearanceMode, extensions, resolvedAppearance, themeSelection]);

	return null;
}
