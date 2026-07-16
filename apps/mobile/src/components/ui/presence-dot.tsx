import { useEffect } from "react";
import { type ColorValue, View } from "react-native";
import Animated, {
	cancelAnimation,
	Easing,
	useAnimatedStyle,
	useReducedMotion,
	useSharedValue,
	withRepeat,
	withTiming,
} from "react-native-reanimated";
import { colors } from "~/theme";

export type PresenceTone = "online" | "offline" | "checking" | "error";

// Live-presence tones. Mirrors the `--color-presence-*` tokens in `global.css`;
// kept as plain strings here because the animated halo/core are styled inline
// (RN inline styles can't read CSS custom properties). The halo reuses the same
// tone at a lower, animated opacity rather than a separate translucent color.
const TONE: Record<PresenceTone, ColorValue> = {
	online: colors.success,
	offline: colors.secondaryFg,
	checking: colors.warning,
	error: colors.danger,
};

/**
 * A presence indicator dot with an optional pulsing halo — the iOS idiom for
 * "this is live / working on it". While `pulse` is on, a soft halo breathes out
 * from the solid core on a ~1.1s cadence; when it turns off the halo settles
 * away. Respects Reduce Motion (renders a static dot).
 */
export function PresenceDot({
	tone,
	pulse,
	size = 10,
}: {
	readonly tone: PresenceTone;
	readonly pulse: boolean;
	readonly size?: number;
}) {
	const reducedMotion = useReducedMotion();
	const active = pulse && !reducedMotion;
	const progress = useSharedValue(0);

	const dotSize = size;
	const haloSize = dotSize + 4;
	const containerSize = haloSize + 4;
	const color = TONE[tone];

	useEffect(() => {
		if (active) {
			progress.value = withRepeat(
				withTiming(1, { duration: 1100, easing: Easing.out(Easing.cubic) }),
				-1,
				false,
			);
			return;
		}
		cancelAnimation(progress);
		progress.value = withTiming(0, {
			duration: 180,
			easing: Easing.out(Easing.quad),
		});
	}, [active, progress]);

	const haloStyle = useAnimatedStyle(() => ({
		opacity: active ? 0.14 + (1 - progress.value) * 0.3 : 0,
		transform: [{ scale: 0.78 + progress.value * 1.16 }],
	}));

	return (
		<View
			style={{
				width: containerSize,
				height: containerSize,
				alignItems: "center",
				justifyContent: "center",
			}}
		>
			<Animated.View
				style={[
					haloStyle,
					{
						position: "absolute",
						width: haloSize,
						height: haloSize,
						borderRadius: haloSize / 2,
						backgroundColor: color,
					},
				]}
			/>
			<View
				style={{
					width: dotSize,
					height: dotSize,
					borderRadius: dotSize / 2,
					backgroundColor: color,
				}}
			/>
		</View>
	);
}
