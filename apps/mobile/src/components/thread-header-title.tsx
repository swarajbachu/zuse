import { ChevronDown } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";

import { colors } from "~/theme";

export function ThreadHeaderTitle({
	title,
	current,
	total,
	runningCount,
	onPress,
}: {
	title: string;
	current: number;
	total: number;
	runningCount: number;
	onPress: () => void;
}) {
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={`Open threads. Thread ${current} of ${total}`}
			hitSlop={8}
			onPress={onPress}
			className="min-h-11 max-w-[230px] items-center justify-center px-2 active:opacity-70"
		>
			<Text
				className="font-sans-bold text-[16px] text-foreground"
				numberOfLines={1}
			>
				{title}
			</Text>
			{total > 1 ? (
				<View className="mt-0.5 flex-row items-center gap-1">
					<Text className="font-sans text-[11px] text-muted-foreground">
						Thread {current} of {total}
						{runningCount > 1 ? ` · ${runningCount} running` : ""}
					</Text>
					<ChevronDown size={11} color={colors.secondaryFg} />
				</View>
			) : null}
		</Pressable>
	);
}
