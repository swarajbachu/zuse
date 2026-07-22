import { useState } from "react";
import { Image, Text, View } from "react-native";

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
	// Track the URL that failed (not a sticky flag) so a better URL arriving
	// later — e.g. the GitHub owner avatar once the origin loads — still shows.
	const [failedUrl, setFailedUrl] = useState<string | null>(null);
	const source = avatarUrl !== null && avatarUrl !== failedUrl ? avatarUrl : null;
	return (
		<View
			className={cn(
				"items-center justify-center overflow-hidden rounded-xl border border-border bg-muted",
			)}
			style={{ width: size, height: size, borderCurve: "continuous" }}
		>
			{source ? (
				<Image
					source={{ uri: source }}
					style={{ width: size, height: size }}
					resizeMode="cover"
					onError={() => setFailedUrl(avatarUrl)}
				/>
			) : (
				<Text className="font-sans-bold text-[15px] text-primary">
					{(title.trim()[0] ?? "P").toUpperCase()}
				</Text>
			)}
		</View>
	);
}
