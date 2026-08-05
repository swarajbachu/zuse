import { X } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";

import { colors } from "~/theme";

export function InlineErrorNotice({
	message,
	onDismiss,
	compact = false,
}: {
	message: string;
	onDismiss?: () => void;
	compact?: boolean;
}) {
	return (
		<View
			accessibilityRole="alert"
			className="min-h-11 flex-row items-center gap-2 px-3"
		>
			<View className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
			<Text
				selectable
				numberOfLines={compact ? 2 : undefined}
				className="min-w-0 flex-1 font-sans text-[13px] leading-5 text-muted-foreground"
			>
				{message}
			</Text>
			{onDismiss === undefined ? null : (
				<Pressable
					accessibilityRole="button"
					accessibilityLabel="Dismiss error"
					hitSlop={8}
					onPress={onDismiss}
					className="h-11 w-11 items-center justify-center rounded-full active:bg-muted"
				>
					<X size={16} color={colors.secondaryFg} />
				</Pressable>
			)}
		</View>
	);
}
