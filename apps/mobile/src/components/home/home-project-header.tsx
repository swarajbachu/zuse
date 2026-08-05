import { ChevronDown, ChevronRight, Github } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";

import { PresenceDot } from "~/components/ui/presence-dot";
import type { InboxProjectGroup } from "~/lib/inbox";
import { colors } from "~/theme";

export function HomeProjectHeader({
	group,
	collapsed,
	onToggle,
}: {
	group: InboxProjectGroup;
	collapsed: boolean;
	onToggle: () => void;
}) {
	const Chevron = collapsed ? ChevronRight : ChevronDown;

	return (
		<Pressable
			accessibilityRole="button"
			accessibilityState={{ expanded: !collapsed }}
			accessibilityLabel={`${group.title}, ${group.rows.length} chats${
				collapsed ? ", collapsed" : ""
			}`}
			onPress={onToggle}
			className="mt-2 min-h-12 flex-row items-center gap-2.5 rounded-xl px-3 active:bg-muted"
		>
			<Github size={18} color={colors.fg} />
			<Text
				className="min-w-0 flex-1 font-sans-medium text-[15px] text-foreground"
				numberOfLines={1}
			>
				{group.title}
			</Text>
			{group.activeCount > 0 ? (
				<View className="h-5 min-w-5 flex-row items-center justify-center gap-1">
					<PresenceDot tone="online" pulse size={6} />
					<Text
						className="font-sans text-[11px] text-muted-foreground"
						style={{ fontVariant: ["tabular-nums"] }}
					>
						{group.activeCount}
					</Text>
				</View>
			) : null}
			<Text
				className="font-sans text-[12px] text-muted-foreground"
				style={{ fontVariant: ["tabular-nums"] }}
			>
				{group.rows.length}
			</Text>
			<Chevron size={14} color={colors.tertiaryFg} />
		</Pressable>
	);
}
