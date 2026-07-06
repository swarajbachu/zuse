import { Platform, StyleSheet, View, type ViewProps } from "react-native";
import { GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect";

// rounded-2xl — matches the app's other inset surfaces.
const RADIUS = 16;

const styles = StyleSheet.create({
  base: { borderRadius: RADIUS, borderCurve: "continuous" },
  glass: { overflow: "hidden" },
  // Mirrors `bg-card` + `border-border` for the pre-iOS-26 fallback.
  fallback: {
    backgroundColor: "hsl(72 4% 13%)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.1)",
  },
});

/**
 * A rounded surface that becomes real iOS 26 "liquid glass" where the Glass
 * Effect API is available, and falls back to the opaque card treatment
 * everywhere else. Layout (flex/padding/etc.) is supplied by the caller via
 * `style`; this component only owns the background/border/corner treatment.
 */
export function GlassSurface({ style, children, ...rest }: ViewProps) {
  const supportsGlass = Platform.OS === "ios" && isGlassEffectAPIAvailable();

  if (supportsGlass) {
    return (
      <GlassView
        glassEffectStyle="regular"
        isInteractive
        colorScheme="dark"
        style={[styles.base, styles.glass, style]}
        {...rest}
      >
        {children}
      </GlassView>
    );
  }

  return (
    <View style={[styles.base, styles.fallback, style]} {...rest}>
      {children}
    </View>
  );
}
