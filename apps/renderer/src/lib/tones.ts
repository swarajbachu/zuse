/**
 * Soft-color tone tokens — the Tailwind Catalyst-style "label" palette.
 * Each tone provides a translucent tint on background, a saturated text
 * color, and a slightly darker tint on hover, in both light and dark mode.
 *
 * Pair `softTone(t)` with `softInteractive(t)` so a static badge and the
 * button next to it always pick up the same hue. Used by the workflow
 * pills + actions in the top bar; reach for these whenever a UI surface
 * needs a colored chip rather than rolling fresh tokens.
 */

export type Tone =
	| "red"
	| "orange"
	| "amber"
	| "yellow"
	| "lime"
	| "green"
	| "emerald"
	| "teal"
	| "cyan"
	| "sky"
	| "blue"
	| "indigo"
	| "violet"
	| "purple"
	| "fuchsia"
	| "pink"
	| "rose"
	| "zinc";

/** Static background + text for a badge / pill (no hover state). */
export const SOFT_TONE: Record<Tone, string> = {
	red: "bg-red-500/15 text-red-700 dark:bg-red-500/10 dark:text-red-400",
	orange:
		"bg-orange-500/15 text-orange-700 dark:bg-orange-500/10 dark:text-orange-400",
	amber:
		"bg-amber-400/20 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400",
	yellow:
		"bg-yellow-400/20 text-yellow-700 dark:bg-yellow-400/10 dark:text-yellow-300",
	lime: "bg-lime-400/20 text-lime-700 dark:bg-lime-400/10 dark:text-lime-300",
	green:
		"bg-green-500/15 text-green-700 dark:bg-green-500/10 dark:text-green-400",
	emerald:
		"bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400",
	teal: "bg-teal-500/15 text-teal-700 dark:bg-teal-500/10 dark:text-teal-300",
	cyan: "bg-cyan-400/20 text-cyan-700 dark:bg-cyan-400/10 dark:text-cyan-300",
	sky: "bg-sky-500/15 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300",
	blue: "bg-blue-500/15 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400",
	indigo:
		"bg-indigo-500/15 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-400",
	violet:
		"bg-violet-500/15 text-violet-700 dark:bg-violet-500/15 dark:text-violet-400",
	purple:
		"bg-purple-500/15 text-purple-700 dark:bg-purple-500/15 dark:text-purple-400",
	fuchsia:
		"bg-fuchsia-400/15 text-fuchsia-700 dark:bg-fuchsia-400/10 dark:text-fuchsia-400",
	pink: "bg-pink-400/15 text-pink-700 dark:bg-pink-400/10 dark:text-pink-400",
	rose: "bg-rose-400/15 text-rose-700 dark:bg-rose-400/10 dark:text-rose-400",
	zinc: "bg-zinc-600/10 text-zinc-700 dark:bg-white/5 dark:text-zinc-400",
};

/** Hover-only deltas — compose with `SOFT_TONE` for clickable chips. */
export const SOFT_TONE_HOVER: Record<Tone, string> = {
	red: "hover:bg-red-500/25 dark:hover:bg-red-500/20",
	orange: "hover:bg-orange-500/25 dark:hover:bg-orange-500/20",
	amber: "hover:bg-amber-400/30 dark:hover:bg-amber-400/15",
	yellow: "hover:bg-yellow-400/30 dark:hover:bg-yellow-400/15",
	lime: "hover:bg-lime-400/30 dark:hover:bg-lime-400/15",
	green: "hover:bg-green-500/25 dark:hover:bg-green-500/20",
	emerald: "hover:bg-emerald-500/25 dark:hover:bg-emerald-500/20",
	teal: "hover:bg-teal-500/25 dark:hover:bg-teal-500/20",
	cyan: "hover:bg-cyan-400/30 dark:hover:bg-cyan-400/15",
	sky: "hover:bg-sky-500/25 dark:hover:bg-sky-500/20",
	blue: "hover:bg-blue-500/25 dark:hover:bg-blue-500/25",
	indigo: "hover:bg-indigo-500/25 dark:hover:bg-indigo-500/20",
	violet: "hover:bg-violet-500/25 dark:hover:bg-violet-500/20",
	purple: "hover:bg-purple-500/25 dark:hover:bg-purple-500/20",
	fuchsia: "hover:bg-fuchsia-400/25 dark:hover:bg-fuchsia-400/20",
	pink: "hover:bg-pink-400/25 dark:hover:bg-pink-400/20",
	rose: "hover:bg-rose-400/25 dark:hover:bg-rose-400/20",
	zinc: "hover:bg-zinc-600/20 dark:hover:bg-white/10",
};

export const softTone = (tone: Tone): string => SOFT_TONE[tone];
export const softInteractive = (tone: Tone): string =>
	`${SOFT_TONE[tone]} ${SOFT_TONE_HOVER[tone]}`;

/**
 * Saturated background + white text for primary actions (the GitHub-style
 * green Merge button, etc.). Use when a button is the unambiguous primary
 * call-to-action; lean on `softInteractive` for secondary chips.
 */
export const SOLID_TONE: Record<Tone, string> = {
	red: "bg-red-600 text-white hover:bg-red-500 dark:bg-red-500 dark:hover:bg-red-400",
	orange:
		"bg-orange-600 text-white hover:bg-orange-500 dark:bg-orange-500 dark:hover:bg-orange-400",
	amber:
		"bg-amber-500 text-amber-950 hover:bg-amber-400 dark:bg-amber-400 dark:text-amber-950 dark:hover:bg-amber-300",
	yellow:
		"bg-yellow-500 text-yellow-950 hover:bg-yellow-400 dark:bg-yellow-400 dark:text-yellow-950 dark:hover:bg-yellow-300",
	lime: "bg-lime-500 text-lime-950 hover:bg-lime-400 dark:bg-lime-400 dark:text-lime-950 dark:hover:bg-lime-300",
	green:
		"bg-green-600 text-white hover:bg-green-500 dark:bg-green-500 dark:hover:bg-green-400",
	emerald:
		"bg-emerald-600 text-white hover:bg-emerald-500 dark:bg-emerald-500 dark:hover:bg-emerald-400",
	teal: "bg-teal-600 text-white hover:bg-teal-500 dark:bg-teal-500 dark:hover:bg-teal-400",
	cyan: "bg-cyan-500 text-cyan-950 hover:bg-cyan-400 dark:bg-cyan-400 dark:text-cyan-950 dark:hover:bg-cyan-300",
	sky: "bg-sky-600 text-white hover:bg-sky-500 dark:bg-sky-500 dark:hover:bg-sky-400",
	blue: "bg-blue-600 text-white hover:bg-blue-500 dark:bg-blue-500 dark:hover:bg-blue-400",
	indigo:
		"bg-indigo-600 text-white hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400",
	violet:
		"bg-violet-600 text-white hover:bg-violet-500 dark:bg-violet-500 dark:hover:bg-violet-400",
	purple:
		"bg-purple-600 text-white hover:bg-purple-500 dark:bg-purple-500 dark:hover:bg-purple-400",
	fuchsia:
		"bg-fuchsia-600 text-white hover:bg-fuchsia-500 dark:bg-fuchsia-500 dark:hover:bg-fuchsia-400",
	pink: "bg-pink-600 text-white hover:bg-pink-500 dark:bg-pink-500 dark:hover:bg-pink-400",
	rose: "bg-rose-600 text-white hover:bg-rose-500 dark:bg-rose-500 dark:hover:bg-rose-400",
	zinc: "bg-zinc-700 text-white hover:bg-zinc-600 dark:bg-zinc-200 dark:text-zinc-900 dark:hover:bg-zinc-100",
};

export const solidInteractive = (tone: Tone): string => SOLID_TONE[tone];
