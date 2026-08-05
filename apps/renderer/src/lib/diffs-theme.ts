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
 * Pierre renders its theme inside Shadow DOM and declares the base colors on
 * `:host`. Inherited custom properties therefore cannot replace those values.
 * `unsafeCSS` is the library's documented highest-priority styling escape hatch;
 * keep this override intentionally small and restricted to the host tokens.
 */
const ZUSE_DIFF_UNSAFE_CSS = `
:host {
  --diffs-light-bg: var(--background);
  --diffs-dark-bg: var(--background);
  --diffs-light: var(--foreground);
  --diffs-dark: var(--foreground);
  background-color: var(--background);
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
