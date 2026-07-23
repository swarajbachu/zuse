import type { ColorValue } from "react-native";
import { Text, View } from "react-native";

import { cn } from "~/lib/cn";
import type { branchStatePresentation } from "~/lib/pr-state-presentation";
import { colors } from "~/theme";

type BranchState = ReturnType<typeof branchStatePresentation>;

export function BranchStateBadge({ state }: { state: BranchState }) {
	if (state === null) return null;
	return (
		<View
			className={cn(
				"max-w-[112px] flex-row items-center gap-1 rounded-full px-2 py-0.5",
				state.tone === "brand" && "bg-primary/15",
				state.tone === "success" && "bg-success/15",
				state.tone === "danger" && "bg-danger/15",
				state.tone === "warning" && "bg-warning/15",
				state.tone === "neutral" && "bg-muted",
			)}
		>
			<BranchGlyph color={branchToneColor(state.tone)} icon={state.icon} />
			<Text
				className={cn(
					"font-sans-medium text-[11px]",
					state.tone === "brand" && "text-primary",
					state.tone === "success" && "text-success",
					state.tone === "danger" && "text-danger",
					state.tone === "warning" && "text-warning",
					state.tone === "neutral" && "text-muted-foreground",
				)}
				numberOfLines={1}
			>
				{state.label}
			</Text>
		</View>
	);
}

function BranchGlyph({
	color,
	icon,
}: {
	color: ColorValue;
	icon: NonNullable<BranchState>["icon"];
}) {
	if (icon === "warning" || icon === "closed") {
		return (
			<View className="h-3 w-3 items-center justify-center">
				<Text
					className="font-sans-bold text-[10px]"
					style={{ color, lineHeight: 12 }}
				>
					{icon === "warning" ? "!" : "x"}
				</Text>
			</View>
		);
	}
	return (
		<View style={{ width: 12, height: 12 }}>
			<View
				style={{
					position: "absolute",
					left: 2,
					top: 2,
					width: 4,
					height: 4,
					borderRadius: 2,
					borderWidth: 1.4,
					borderColor: color,
				}}
			/>
			<View
				style={{
					position: "absolute",
					right: 1,
					bottom: 1,
					width: 4,
					height: 4,
					borderRadius: 2,
					borderWidth: 1.4,
					borderColor: color,
				}}
			/>
			<View
				style={{
					position: "absolute",
					left: 4,
					top: 6,
					width: 1.4,
					height: 4,
					borderRadius: 1,
					backgroundColor: color,
				}}
			/>
			<View
				style={{
					position: "absolute",
					left: 5,
					top: 8,
					width: 4,
					height: 1.4,
					borderRadius: 1,
					backgroundColor: color,
				}}
			/>
		</View>
	);
}

function branchToneColor(
	tone: "brand" | "neutral" | "danger" | "success" | "warning",
): ColorValue {
	switch (tone) {
		case "brand":
			return colors.accent;
		case "success":
			return colors.success;
		case "danger":
			return colors.danger;
		case "warning":
			return colors.warning;
		case "neutral":
			return colors.secondaryFg;
	}
}
