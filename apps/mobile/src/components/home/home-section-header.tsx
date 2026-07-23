import { Text, View } from "react-native";

import type { HomeFeedSection } from "~/lib/home-feed";

export function HomeSectionHeader({ title }: { title: HomeFeedSection }) {
	return (
		<View className="px-1 pb-2 pt-5">
			<Text className="font-sans-medium text-[13px] uppercase tracking-wider text-muted-foreground">
				{title}
			</Text>
		</View>
	);
}
