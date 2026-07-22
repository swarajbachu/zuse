import Task01Icon from "@hugeicons-pro/core-solid-rounded/Task01Icon";
import { X } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";

import { colors } from "~/theme";
import { HugeIcon } from "./ui/huge-icon";

/** Compact, unboxed mode state that shares the composer's fixed action rail. */
export function ComposerModeChip({
	label,
	plan = false,
	onClear,
}: {
	label: string;
	plan?: boolean;
	onClear: () => void;
}) {
	const tint = plan ? colors.accent : colors.fg;

	return (
		<View className="h-11 flex-row items-center gap-1">
			{plan ? <HugeIcon icon={Task01Icon} size={15} color={tint} /> : null}
			<Text className="font-sans-medium text-[13px]" style={{ color: tint }}>
				{label}
			</Text>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={`Clear ${label.toLowerCase()} mode`}
				onPress={onClear}
				hitSlop={10}
				className="h-11 w-6 items-center justify-center"
			>
				<X size={13} color={colors.secondaryFg} />
			</Pressable>
		</View>
	);
}
