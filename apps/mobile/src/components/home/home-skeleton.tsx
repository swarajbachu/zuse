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
	const pulse = useSharedValue(0.72);

	useEffect(() => {
		if (reducedMotion) return;
		pulse.value = withRepeat(withTiming(1, { duration: 900 }), -1, true);
	}, [pulse, reducedMotion]);

	const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

	return (
		<View
			accessible
			accessibilityRole="progressbar"
			accessibilityLabel="Loading chats"
		>
			{ROWS.map((index) => (
				<View
					key={index}
					className={cn("min-h-[58px] px-4 py-3", index === 0 && "mt-3")}
				>
					<Animated.View
						className="flex-1 flex-row items-center gap-2.5"
						style={pulseStyle}
					>
						<View className="h-2 w-2 rounded-full bg-muted" />
						<View className="h-3.5 flex-1 rounded-full bg-muted" />
						<View className="h-3 w-8 rounded-full bg-muted" />
					</Animated.View>
				</View>
			))}
		</View>
	);
}
