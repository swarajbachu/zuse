import { Image } from "expo-image";
import { useState } from "react";
import { Text, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";

import { cn } from "~/lib/cn";

export function ProjectLogo({
	title,
	avatarUrl,
	size = 40,
}: {
	title: string;
	avatarUrl: string | null;
	size?: number;
}) {
	const reduceMotion = useReducedMotion();
	// Track the URL that failed (not a sticky flag) so a better URL arriving
	// later — e.g. the canonical owner avatar once the origin loads — still shows.
	const [failedUrl, setFailedUrl] = useState<string | null>(null);
	const source =
		avatarUrl !== null && avatarUrl !== failedUrl ? avatarUrl : null;
	return (
		<View
			className={cn(
				"items-center justify-center overflow-hidden rounded-xl border border-border bg-muted",
			)}
			style={{ width: size, height: size, borderCurve: "continuous" }}
		>
			{source ? (
				<Image
					source={source}
					style={{ width: size, height: size }}
					contentFit="cover"
					cachePolicy="memory-disk"
					recyclingKey={source}
					transition={reduceMotion ? 0 : 120}
					onError={() => setFailedUrl(source)}
				/>
			) : (
				<Text className="font-sans-bold text-[15px] text-primary">
					{(title.trim()[0] ?? "P").toUpperCase()}
				</Text>
			)}
		</View>
	);
}
