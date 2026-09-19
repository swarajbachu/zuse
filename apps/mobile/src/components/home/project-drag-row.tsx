import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { Animated, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { selectionTap } from "~/lib/haptics";

export function ProjectDragRow({
	children,
	enabled,
	register,
	onStart,
	onDrop,
	onFinish,
}: {
	children: ReactNode;
	enabled: boolean;
	register: (view: View | null) => void;
	onStart: () => void;
	onDrop: (screenY: number) => void;
	onFinish: () => void;
}) {
	const y = useRef(new Animated.Value(0)).current;
	const [active, setActive] = useState(false);
	const pan = Gesture.Pan()
		.enabled(enabled)
		.activateAfterLongPress(350)
		.runOnJS(true)
		.onStart(() => {
			setActive(true);
			selectionTap();
			onStart();
		})
		.onUpdate((event) => y.setValue(event.translationY))
		.onEnd((event) => onDrop(event.absoluteY))
		.onFinalize(() => {
			y.setValue(0);
			setActive(false);
			onFinish();
		});
	return (
		<View ref={register} collapsable={false}>
			<GestureDetector gesture={pan}>
				<Animated.View
					style={{
						transform: [{ translateY: y }],
						borderRadius: 12,
						borderCurve: "continuous",
						overflow: "hidden",
						opacity: active ? 0.85 : 1,
					}}
					className={active ? "bg-muted" : undefined}
				>
					{children}
				</Animated.View>
			</GestureDetector>
		</View>
	);
}
