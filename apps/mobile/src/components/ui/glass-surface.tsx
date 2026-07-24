import { GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect";
import { Platform, StyleSheet, View, type ViewProps } from "react-native";
import { useUniwind } from "uniwind";

import { glass, radii } from "~/theme";

const styles = StyleSheet.create({
	base: { borderRadius: radii.lg, borderCurve: "continuous" },
	glass: { overflow: "hidden" },
	// Mirrors `bg-card` + `border-border` for the pre-iOS-26 fallback.
	fallback: { borderWidth: StyleSheet.hairlineWidth },
});

/**
 * A rounded surface that becomes real iOS 26 "liquid glass" where the Glass
 * Effect API is available, and falls back to the opaque card treatment
 * everywhere else. Layout (flex/padding/etc.) is supplied by the caller via
 * `style`; this component only owns the background/border/corner treatment.
 */
export function GlassSurface({ style, children, ...rest }: ViewProps) {
	const { theme } = useUniwind();
	const supportsGlass = Platform.OS === "ios" && isGlassEffectAPIAvailable();

	if (supportsGlass) {
		return (
			<GlassView
				glassEffectStyle="regular"
				isInteractive
				colorScheme={theme === "dark" ? "dark" : "light"}
				style={[styles.base, styles.glass, style]}
				{...rest}
			>
				{children}
			</GlassView>
		);
	}

	return (
		<View
			style={[
				styles.base,
				styles.fallback,
				{
					backgroundColor:
						theme === "dark" ? glass.surfaceDark : glass.surfaceLight,
					borderColor:
						theme === "dark" ? glass.hairlineDark : glass.hairlineLight,
				},
				style,
			]}
			{...rest}
		>
			{children}
		</View>
	);
}
