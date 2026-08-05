import { Text, View } from "react-native";

import type { HomeFeedSection } from "~/lib/home-feed";

export function HomeSectionHeader({ title }: { title: HomeFeedSection }) {
	return (
		<View className="px-3 pb-1 pt-5">
			<Text className="font-sans-medium text-[13px] text-muted-foreground">
				{title}
			</Text>
		</View>
	);
}
