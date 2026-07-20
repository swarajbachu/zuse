import type { ReactNode } from "react";
import { View } from "react-native";

/**
 * Keeps composer actions on one fixed baseline while the multiline input grows
 * independently above them. Native menu hosts stay inside the 44pt action row.
 */
export function ComposerInputFrame({
	input,
	leadingAction,
	trailingAction,
}: {
	input: ReactNode;
	leadingAction: ReactNode;
	trailingAction: ReactNode;
}) {
	return (
		<View className="relative" style={{ paddingBottom: 52 }}>
			{input}
			<View className="absolute inset-x-0 bottom-0 h-11 flex-row items-center justify-between">
				{leadingAction}
				{trailingAction}
			</View>
		</View>
	);
}
