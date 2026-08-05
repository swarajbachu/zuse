import { type BaseCodeOptions, DEFAULT_THEMES } from "@pierre/diffs";
import { useMemo } from "react";
import { useResolvedAppearance } from "./appearance.tsx";

/**
 * The worker pool owns syntax-theme registration, so keep one stable light/dark
 * pair for every review renderer. Individual components only select the active
 * half through `themeType`.
 */
export const ZUSE_DIFF_THEMES = DEFAULT_THEMES;

type ZuseDiffThemeOptions = Pick<BaseCodeOptions, "theme" | "themeType">;

export function useZuseDiffTheme(): ZuseDiffThemeOptions {
	const themeType = useResolvedAppearance();
	return useMemo(
		() => ({
			theme: ZUSE_DIFF_THEMES,
			themeType,
		}),
		[themeType],
	);
}
