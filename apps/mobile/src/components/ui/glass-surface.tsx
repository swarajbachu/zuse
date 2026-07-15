import { GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect";
import {
	Platform,
	StyleSheet,
	useColorScheme,
	View,
	type ViewProps,
} from "react-native";

import { colors } from "~/theme";

// rounded-2xl — matches the app's other inset surfaces.
const RADIUS = 16;

const styles = StyleSheet.create({
	base: { borderRadius: RADIUS, borderCurve: "continuous" },
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
	const colorScheme = useColorScheme();
	const supportsGlass = Platform.OS === "ios" && isGlassEffectAPIAvailable();

	if (supportsGlass) {
		return (
			<GlassView
				glassEffectStyle="regular"
				isInteractive
				colorScheme={colorScheme === "dark" ? "dark" : "light"}
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
				{ backgroundColor: colors.card, borderColor: colors.border },
				style,
			]}
			{...rest}
		>
			{children}
		</View>
	);
}
