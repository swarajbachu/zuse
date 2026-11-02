import { QrCode } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { cn } from "~/lib/cn";
import {
	CONNECTION_NOTICE_DELAY_MS,
	CONNECTION_NOTICE_MIN_VISIBLE_MS,
	type ConnectionNotice,
} from "~/lib/connection-notice";
import { colors } from "~/theme";

/**
 * Progress waits out a short grace period so silent socket swaps never flash;
 * problems show at once. A shown notice stays briefly so it can be read.
 */
function useSettledNotice(
	notice: ConnectionNotice | null,
): ConnectionNotice | null {
	const [visible, setVisible] = useState(notice?.tone === "problem");
	const shownAt = useRef(0);
	const latest = useRef(notice);
	const active = notice !== null;
	const immediate = notice?.tone === "problem";

	useEffect(() => {
		if (notice !== null) latest.current = notice;
	}, [notice]);

	useEffect(() => {
		if (active === visible) return;
		const delay = active
			? immediate
				? 0
				: CONNECTION_NOTICE_DELAY_MS
			: Math.max(
					0,
					CONNECTION_NOTICE_MIN_VISIBLE_MS - (Date.now() - shownAt.current),
				);
		const timer = setTimeout(() => {
			if (active) shownAt.current = Date.now();
			setVisible(active);
		}, delay);
		return () => clearTimeout(timer);
	}, [active, immediate, visible]);

	return visible ? (notice ?? latest.current) : null;
}

export function ConnectionRecoveryBanner({
	notice,
	onRetry,
	onPairAgain,
	className,
}: {
	notice: ConnectionNotice | null;
	onRetry: () => void;
	onPairAgain?: () => void;
	className?: string;
}) {
	const shown = useSettledNotice(notice);
	if (shown === null) return null;
	return (
		<Animated.View
			entering={FadeIn.duration(200)}
			exiting={FadeOut.duration(160)}
		>
			<View
				accessibilityRole="alert"
				accessibilityLiveRegion="polite"
				className={cn(
					"min-h-12 flex-row items-center gap-2.5 rounded-2xl bg-card pl-3.5 pr-1",
					className,
				)}
				style={{ borderCurve: "continuous" }}
			>
				<View className="h-5 w-5 items-center justify-center">
					{shown.tone === "progress" ? (
						<ActivityIndicator size="small" color={colors.secondaryFg} />
					) : (
						<View className="h-2 w-2 rounded-full bg-warning" />
					)}
				</View>
				<View className="min-w-0 flex-1 gap-0.5 py-2">
					<Text
						numberOfLines={1}
						className="font-sans-medium text-[13px] text-foreground"
					>
						{shown.title}
					</Text>
					{shown.detail === null ? null : (
						<Text
							numberOfLines={2}
							className="font-sans text-[12px] leading-4 text-muted-foreground"
						>
							{shown.detail}
						</Text>
					)}
				</View>
				{shown.canPairAgain && onPairAgain !== undefined ? (
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Scan a new pairing code"
						onPress={onPairAgain}
						className="h-11 w-11 items-center justify-center rounded-full active:opacity-60"
					>
						<QrCode size={16} color={colors.secondaryFg} />
					</Pressable>
				) : null}
				{shown.canRetry ? (
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Retry connection"
						onPress={onRetry}
						className="h-11 justify-center px-3 active:opacity-60"
					>
						<Text className="font-sans-medium text-[13px] text-accent">
							Retry
						</Text>
					</Pressable>
				) : null}
			</View>
		</Animated.View>
	);
}
