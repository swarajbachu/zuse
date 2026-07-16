import { Color } from "expo-router";
import { Platform } from "react-native";

const platformColor = <T>(ios: T, android: T | undefined, fallback: T): T =>
	Platform.select({ ios, android: android ?? fallback, default: fallback }) ??
	fallback;

/** Native semantic colors. UIKit/Material re-resolve these for light/dark mode. */
export const colors = {
	bg: platformColor(
		Color.ios.systemBackground,
		Color.android.dynamic.surface,
		"#ffffff",
	),
	fg: platformColor(
		Color.ios.label,
		Color.android.dynamic.onSurface,
		"#111111",
	),
	secondaryFg: platformColor(
		Color.ios.secondaryLabel,
		Color.android.dynamic.onSurfaceVariant,
		"#6b6b70",
	),
	tertiaryFg: platformColor(
		Color.ios.tertiaryLabel,
		Color.android.dynamic.onSurfaceVariant,
		"#8e8e93",
	),
	mutedFg: platformColor(
		Color.ios.secondaryLabel,
		Color.android.dynamic.onSurfaceVariant,
		"#6b6b70",
	),
	card: platformColor(
		Color.ios.secondarySystemBackground,
		Color.android.dynamic.surfaceContainer,
		"#f2f2f7",
	),
	cardElevated: platformColor(
		Color.ios.tertiarySystemBackground,
		Color.android.dynamic.surfaceContainerHigh,
		"#ffffff",
	),
	border: platformColor(
		Color.ios.separator,
		Color.android.dynamic.outlineVariant,
		"rgba(60,60,67,0.22)",
	),
	accent: platformColor(
		Color.ios.systemGreen,
		Color.android.dynamic.primary,
		"#34c759",
	),
	danger: platformColor(
		Color.ios.systemRed,
		Color.android.dynamic.error,
		"#ff3b30",
	),
	warning: platformColor(
		Color.ios.systemOrange,
		Color.android.material.yellow600,
		"#ff9500",
	),
	success: platformColor(
		Color.ios.systemGreen,
		Color.android.material.green600,
		"#34c759",
	),
	diffAdded: "#269a3b",
	diffRemoved: "#d93f4c",
	diffHunk: "#a63aa5",
	// Filled add/remove row backgrounds (like the web diff). Low-alpha tints read
	// correctly over both light and dark surfaces.
	diffAddedBg: "rgba(38,154,59,0.14)",
	diffRemovedBg: "rgba(217,63,76,0.14)",
} as const;

export const spacing = {
	xs: 4,
	sm: 8,
	md: 12,
	lg: 16,
	xl: 24,
} as const;

export const radii = {
	sm: 6,
	md: 8,
} as const;
