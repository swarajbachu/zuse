import { Color } from "expo-router";
import { Platform } from "react-native";

/** The single product accent used across native controls and utility styles. */
export const NEON_GREEN = "#c8ff00";
export const PRIMARY_FOREGROUND = "#11130a";

export const glass = {
	borderDark: "rgba(255,255,255,0.16)",
	borderLight: "rgba(0,0,0,0.12)",
	fillDark: "rgba(24,24,24,0.72)",
	fillLight: "rgba(255,255,255,0.78)",
	surfaceDark: "hsl(0 0% 12%)",
	surfaceLight: "#ffffff",
	hairlineDark: "rgba(255,255,255,0.1)",
	hairlineLight: "rgba(0,0,0,0.08)",
} as const;

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
		"#262626",
	),
	secondaryFg: platformColor(
		Color.ios.secondaryLabel,
		Color.android.dynamic.onSurfaceVariant,
		"#686868",
	),
	tertiaryFg: platformColor(
		Color.ios.tertiaryLabel,
		Color.android.dynamic.onSurfaceVariant,
		"#8f8f8f",
	),
	mutedFg: platformColor(
		Color.ios.secondaryLabel,
		Color.android.dynamic.onSurfaceVariant,
		"#686868",
	),
	card: platformColor(
		Color.ios.secondarySystemBackground,
		Color.android.dynamic.surfaceContainer,
		"#ffffff",
	),
	cardElevated: platformColor(
		Color.ios.tertiarySystemBackground,
		Color.android.dynamic.surfaceContainerHigh,
		"rgba(0,0,0,0.04)",
	),
	border: platformColor(
		Color.ios.separator,
		Color.android.dynamic.outlineVariant,
		"rgba(0,0,0,0.08)",
	),
	accent: platformColor(NEON_GREEN, NEON_GREEN, NEON_GREEN),
	primaryForeground: PRIMARY_FOREGROUND,
	danger: platformColor(
		Color.ios.systemRed,
		Color.android.dynamic.error,
		"#dc2626",
	),
	warning: platformColor(
		Color.ios.systemOrange,
		Color.android.material.yellow600,
		"#d97706",
	),
	success: platformColor(NEON_GREEN, NEON_GREEN, NEON_GREEN),
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
	sm: 12,
	md: 16,
	lg: 24,
	pill: 999,
} as const;
