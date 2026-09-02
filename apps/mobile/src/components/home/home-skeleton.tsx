import { ActivityIndicator, View } from "react-native";

import { colors } from "~/theme";

/** Placeholder rows while the first inbox load is in flight. */
export function HomeSkeleton() {
	return (
		<View
			accessible
			accessibilityRole="progressbar"
			accessibilityLabel="Loading chats"
			className="items-center justify-center py-12"
		>
			<ActivityIndicator size="small" color={colors.secondaryFg} />
		</View>
	);
}
