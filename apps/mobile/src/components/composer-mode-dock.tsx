import { Task01Icon } from "@hugeicons-pro/core-solid-rounded";
import { X } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";

import { colors, PLAN_MODE_TINT } from "~/theme";
import { GlassSurface } from "./ui/glass-surface";
import { HugeIcon } from "./ui/huge-icon";

export function ComposerModeDock({
	planMode,
	goalMode,
	onClearPlan,
	onClearGoal,
}: {
	planMode: boolean;
	goalMode: boolean;
	onClearPlan: () => void;
	onClearGoal: () => void;
}) {
	if (!planMode && !goalMode) return null;

	return (
		<View className="mb-2 items-end px-2">
			<GlassSurface
				accessibilityLabel="Composer modes and model"
				style={{
					alignSelf: "flex-end",
					maxWidth: "100%",
					paddingHorizontal: 6,
					paddingVertical: 2,
					borderRadius: 20,
				}}
			>
				<View className="h-11 max-w-full flex-row items-center gap-1">
					{planMode ? (
						<ModeChip label="Plan" plan onClear={onClearPlan} />
					) : null}
					{goalMode ? <ModeChip label="Goal" onClear={onClearGoal} /> : null}
				</View>
			</GlassSurface>
		</View>
	);
}

function ModeChip({
	label,
	plan = false,
	onClear,
}: {
	label: string;
	plan?: boolean;
	onClear: () => void;
}) {
	return (
		<View className="h-10 flex-row items-center gap-1.5 px-2">
			{plan ? (
				<HugeIcon icon={Task01Icon} size={14} color={PLAN_MODE_TINT} />
			) : null}
			<Text className="font-sans-medium text-[13px] text-foreground">
				{label}
			</Text>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={`Clear ${label.toLowerCase()} mode`}
				onPress={onClear}
				hitSlop={12}
				className="h-6 w-6 items-center justify-center"
			>
				<X size={13} color={colors.secondaryFg} />
			</Pressable>
		</View>
	);
}
