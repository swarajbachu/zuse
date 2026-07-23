import {
	ArrowDown01Icon,
	ArrowRight01Icon,
} from "@hugeicons-pro/core-solid-rounded";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";

import { HugeIcon } from "~/components/ui/huge-icon";
import { PresenceDot } from "~/components/ui/presence-dot";
import { cn } from "~/lib/cn";
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

	return (
		<Pressable
			accessibilityRole="button"
			accessibilityState={{ expanded: !collapsed }}
			accessibilityLabel={`${group.title}, ${group.rows.length} chats${
				collapsed ? ", collapsed" : ""
			}`}
			onPress={onToggle}
			className={cn(
				"mt-3 min-h-[60px] flex-row items-center gap-3 rounded-t-2xl border-x border-t border-border bg-card px-3 py-3 active:opacity-70",
				collapsed && "rounded-b-2xl border-b",
			)}
			style={{ borderCurve: "continuous" }}
		>
			<ProjectLogo title={group.title} avatarUrl={avatarUrl} size={36} />
			<View className="min-w-0 flex-1">
				<View className="flex-row items-center gap-2">
					<Text
						className="min-w-0 shrink font-sans-bold text-[16px] text-foreground"
						numberOfLines={1}
					>
						{group.title}
					</Text>
					{group.activeCount > 0 ? (
						<View className="flex-row items-center gap-1.5 rounded-full bg-muted px-2 py-0.5">
							<PresenceDot tone="online" pulse size={6} />
							<Text
								className="font-sans-medium text-[11px] text-muted-foreground"
								style={{ fontVariant: ["tabular-nums"] }}
							>
								{group.activeCount}
							</Text>
						</View>
					) : null}
				</View>
				<Text
					className="font-sans text-[12px] text-muted-foreground"
					numberOfLines={1}
				>
					{group.connectionLabel} · {group.displayPath}
				</Text>
			</View>
			<Text
				className="font-sans text-[13px] text-muted-foreground"
				style={{ fontVariant: ["tabular-nums"] }}
			>
				{group.rows.length}
			</Text>
			<HugeIcon
				icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
				size={16}
				color={colors.tertiaryFg}
			/>
		</Pressable>
	);
}
