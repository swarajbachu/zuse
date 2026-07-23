import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
	useAnimatedStyle,
	useReducedMotion,
	useSharedValue,
	withRepeat,
	withTiming,
} from "react-native-reanimated";

import { cn } from "~/lib/cn";

const ROWS = [0, 1, 2, 3, 4];

/** Placeholder rows while the first inbox load is in flight. */
export function HomeSkeleton() {
	const reducedMotion = useReducedMotion();
	const pulse = useSharedValue(1);

	useEffect(() => {
		if (reducedMotion) return;
		pulse.value = withRepeat(withTiming(0.5, { duration: 700 }), -1, true);
	}, [pulse, reducedMotion]);

	const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

	return (
		<Animated.View style={pulseStyle} accessibilityLabel="Loading chats">
			{ROWS.map((index) => (
				<View
					key={index}
					className={cn(
						"min-h-[64px] flex-row items-center gap-3 border-x border-t border-border bg-card px-3 py-3",
						index === 0 && "mt-3 rounded-t-2xl",
						index === ROWS.length - 1 && "rounded-b-2xl border-b",
					)}
					style={{ borderCurve: "continuous" }}
				>
					<View className="h-9 w-9 rounded-xl bg-muted" />
					<View className="flex-1 gap-2">
						<View className="h-3.5 w-3/5 rounded-full bg-muted" />
						<View className="h-3 w-2/5 rounded-full bg-muted" />
					</View>
				</View>
			))}
		</Animated.View>
	);
}
