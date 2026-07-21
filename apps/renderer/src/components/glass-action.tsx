import type * as React from "react";

export type GlassTone = "amber" | "pink" | "green" | "blue" | "red" | "zinc";

const TONE_VAR: Record<GlassTone, string> = {
	amber: "var(--accent-amber)",
	pink: "var(--accent-pink)",
	green: "var(--accent-green)",
	blue: "var(--accent-blue)",
	red: "var(--accent-red)",
	zinc: "var(--accent-zinc)",
};

const toneStyle = (tone: GlassTone): React.CSSProperties =>
	({ ["--tone" as string]: TONE_VAR[tone] }) as React.CSSProperties;

/**
 * Workflow-state chip — glass-tinted pill that pairs with the action button.
 * Drives the bg + inset highlight + text color via the shared `--tone` CSS
 * var read by `.glass-tone` in styles.css.
 */
export function GlassChip({
	tone,
	children,
}: {
	tone: GlassTone;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<span
			className="glass-tone flex shrink-0 items-center rounded-md px-2 py-0.5 font-mono text-[10px] font-semibold tracking-tight"
			style={toneStyle(tone)}
		>
			{children}
		</span>
	);
}

/**
 * Workflow primary button — filled glass with subtle inset highlight, tinted
 * by tone. Used in the top bar (commit / push / merge / etc.) and in the
 * Developer settings pane.
 */
export function GlassActionButton({
	tone,
	icon,
	label,
	onClick,
	disabled,
	dense = false,
}: {
	tone: GlassTone;
	icon: React.ReactNode;
	label: string;
	onClick: () => void;
	disabled?: boolean;
	/** Compact in-row variant: smaller, borderless, no ring. */
	dense?: boolean;
}): React.ReactElement {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			style={toneStyle(tone)}
			className={
				dense
					? "glass-tone flex h-6 items-center gap-1 rounded-md px-2 text-[10px] font-semibold tracking-tight shadow-none! transition-colors disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-3 [&_svg]:opacity-90"
					: "glass-tone flex h-7 items-center gap-1.5 rounded-[10px] px-2.5 text-[11px] font-semibold tracking-tight transition-colors disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:opacity-90"
			}
		>
			{icon}
			{label}
		</button>
	);
}

export const GLASS_TONES: ReadonlyArray<GlassTone> = [
	"amber",
	"pink",
	"green",
	"blue",
	"red",
	"zinc",
];

export const GLASS_TONE_VARS: Record<GlassTone, string> = TONE_VAR;
