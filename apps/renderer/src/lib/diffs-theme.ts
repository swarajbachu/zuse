import { type BaseCodeOptions, DEFAULT_THEMES } from "@pierre/diffs";
import { useMemo } from "react";
import { useResolvedAppearance } from "./appearance.tsx";

/**
 * The worker pool owns syntax-theme registration, so keep one stable light/dark
 * pair for every review renderer. Individual components only select the active
 * half through `themeType`.
 */
export const ZUSE_DIFF_THEMES = DEFAULT_THEMES;

/**
 * The renderer paints its host, code, gutters, and separators from the
 * computed `--diffs-bg` token. Making that final token transparent lets the
 * surrounding Zuse pane own the surface while preserving syntax and change
 * highlighting from the selected Shiki theme.
 */
const ZUSE_DIFF_UNSAFE_CSS = `
:host {
  --diffs-bg: transparent;
  --diffs-bg-buffer-override: transparent;
  --diffs-bg-context-override: transparent;
  background-color: transparent;
}

[data-diffs-header] {
  background-color: var(--fz-diff-header-bg);
}
`;

type ZuseDiffThemeOptions = Pick<
	BaseCodeOptions,
	"theme" | "themeType" | "unsafeCSS"
>;

export function useZuseDiffTheme(): ZuseDiffThemeOptions {
	const themeType = useResolvedAppearance();
	return useMemo(
		() => ({
			theme: ZUSE_DIFF_THEMES,
			themeType,
			unsafeCSS: ZUSE_DIFF_UNSAFE_CSS,
		}),
		[themeType],
	);
}
