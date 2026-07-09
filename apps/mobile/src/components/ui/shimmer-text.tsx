import { useEffect } from "react";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

/**
 * Text whose opacity breathes 0.45 → 1 on a ~1.1s loop to signal "the agent is
 * working on this right now" (D4). Reanimated-only opacity loop, no gradient
 * deps. Respects Reduce Motion by rendering at a flat 0.7 opacity. When
 * `active` is false it settles to full opacity (plain static label).
 */
export function ShimmerText({
  children,
  className,
  active = true,
}: {
  children: string;
  className?: string;
  active?: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const animating = active && !reducedMotion;
  const progress = useSharedValue(1);

  useEffect(() => {
    if (animating) {
      progress.value = withRepeat(
        withTiming(0.45, { duration: 1100, easing: Easing.inOut(Easing.quad) }),
        -1,
        true,
      );
      return;
    }
    cancelAnimation(progress);
    progress.value = withTiming(reducedMotion && active ? 0.7 : 1, {
      duration: 180,
    });
  }, [animating, active, reducedMotion, progress]);

  const style = useAnimatedStyle(() => ({ opacity: progress.value }));

  return (
    <Animated.Text style={style} className={className} numberOfLines={1}>
      {children}
    </Animated.Text>
  );
}
