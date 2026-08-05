import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";

import { PresenceDot } from "~/components/ui/presence-dot";
import { optionsForConnection } from "~/lib/connection-params";
import type { InboxProjectGroup } from "~/lib/inbox";
import type { ConnectionRecord } from "~/store/connections";
import { colors } from "~/theme";

import { ProjectLogo } from "./project-logo";
import { useProjectAvatarUrl } from "./use-project-avatar";

export function HomeProjectHeader({
	group,
	collapsed,
	connections,
	onToggle,
}: {
	group: InboxProjectGroup;
	collapsed: boolean;
	connections: ConnectionRecord[];
	onToggle: () => void;
}) {
	const options = useMemo(
		() => optionsForConnection(group.connectionKey, connections),
		[connections, group.connectionKey],
	);
	const avatarUrl = useProjectAvatarUrl({
		connectionKey: group.connectionKey,
		projectId: group.projectId,
		connection: options,
		provisionalUrl: group.avatarUrl,
	});
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
			<ProjectLogo title={group.title} avatarUrl={avatarUrl} size={22} />
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
