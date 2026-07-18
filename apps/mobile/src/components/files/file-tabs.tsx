import SegmentedControl from "@expo/ui/community/segmented-control";
import { View } from "react-native";
import { useUniwind } from "uniwind";

export type FileTab = "modified" | "all";

const VALUES = ["Modified", "All Files"];

export function FileTabs({
	value,
	onChange,
}: {
	value: FileTab;
	onChange: (tab: FileTab) => void;
}) {
	const { theme } = useUniwind();
	return (
		<View className="mx-4 h-10 justify-center">
			<SegmentedControl
				values={VALUES}
				selectedIndex={value === "modified" ? 0 : 1}
				onChange={({ nativeEvent }) =>
					onChange(nativeEvent.selectedSegmentIndex === 0 ? "modified" : "all")
				}
				appearance={theme === "dark" ? "dark" : "light"}
				style={{ height: 32 }}
				testID="file-view-tabs"
			/>
		</View>
	);
}
