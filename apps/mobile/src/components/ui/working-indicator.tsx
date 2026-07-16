import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";

import { colors } from "~/theme";
import { ShimmerText } from "./shimmer-text";

const formatElapsed = (ms: number): string => {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
};

/**
 * The live "working" row — a small spinner plus a shimmering elapsed timer,
 * shown for the whole time the agent is running (like the desktop). Ticks once
 * a second from `since` (epoch ms of the current turn's start).
 */
export function WorkingIndicator({ since }: { since: number }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);
	return (
		<View className="flex-row items-center gap-2 px-2 py-2">
			<ActivityIndicator size="small" color={colors.secondaryFg} />
			<ShimmerText className="font-sans text-[13px] text-muted-foreground">
				{`Working · ${formatElapsed(now - since)}`}
			</ShimmerText>
		</View>
	);
}
