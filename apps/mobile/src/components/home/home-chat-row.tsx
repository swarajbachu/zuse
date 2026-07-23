import { useAtomValue } from "@effect/atom-react";
import {
	ArchiveIcon,
	ArrowRight01Icon,
	PinIcon,
	PinOffIcon,
} from "@hugeicons-pro/core-solid-rounded";
import { Link } from "expo-router";
import { useEffect, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import Swipeable from "react-native-gesture-handler/ReanimatedSwipeable";

import { BranchStateBadge } from "~/components/home/branch-state-badge";
import { ProjectLogo } from "~/components/home/project-logo";
import { useProjectAvatarUrl } from "~/components/home/use-project-avatar";
import { HugeIcon } from "~/components/ui/huge-icon";
import { PresenceDot } from "~/components/ui/presence-dot";
import { cn } from "~/lib/cn";
import { optionsForConnection } from "~/lib/connection-params";
import { projectAvatarUrl } from "~/lib/display-names";
import type { HomeFeedItem } from "~/lib/home-feed";
import { branchStatePresentation } from "~/lib/pr-state-presentation";
import type { ConnectionRecord } from "~/store/connections";
import { hydratePrState, prStateAtom, prStateKey } from "~/store/pr-state";
import { colors } from "~/theme";

type ChatItem = HomeFeedItem & { type: "chat" };

export function HomeChatRow({
	item,
	connections,
	onArchive,
	onTogglePin,
}: {
	item: ChatItem;
	connections: ConnectionRecord[];
	onArchive: (item: ChatItem) => Promise<void>;
	onTogglePin: (item: ChatItem) => void;
}) {
	const row = item.row;
	const options = useMemo(
		() => optionsForConnection(row.connectionKey, connections),
		[connections, row.connectionKey],
	);
	const prKey =
		row.chat?.worktreeId !== undefined && row.chat.worktreeId !== null
			? prStateKey(row.connectionKey, row.projectId, row.chat.worktreeId)
			: null;
	const prInfo = useAtomValue(prStateAtom(prKey ?? "")) ?? null;
	const branchState = branchStatePresentation(prKey === null ? null : prInfo);
	const avatarUrl = useProjectAvatarUrl({
		connectionKey: row.connectionKey,
		projectId: row.projectId,
		connection: options,
		provisionalUrl: projectAvatarUrl(row.projectPath, row.projectName),
	});

	useEffect(() => {
		if (
			row.chat?.worktreeId === undefined ||
			row.chat.worktreeId === null ||
			options === null
		) {
			return;
		}
		void hydratePrState(
			row.connectionKey,
			options,
			row.projectId,
			row.chat.worktreeId,
		);
	}, [options, row.chat?.worktreeId, row.connectionKey, row.projectId]);

	const isActive = row.status === "running" || row.status === "booting";
	const canPin = row.chat !== null;
	const href =
		`/c/${encodeURIComponent(row.connectionKey)}/session/${encodeURIComponent(
			row.session.id,
		)}` as const;
	// Flat sections round their own first row; project rows attach to a header.
	const roundedTop = item.showProject && item.isFirst;

	return (
		<Swipeable
			friction={2}
			leftThreshold={54}
			rightThreshold={54}
			overshootLeft={false}
			overshootRight={false}
			enableTrackpadTwoFingerGesture
			renderLeftActions={
				canPin
					? (_, __, methods) => (
							<Pressable
								accessibilityRole="button"
								accessibilityLabel={row.pinned ? "Unpin chat" : "Pin chat"}
								className={cn(
									"w-24 items-center justify-center border-t border-border bg-muted",
									roundedTop && "rounded-tl-2xl",
									item.isLast && "rounded-bl-2xl border-b",
								)}
								style={{ borderCurve: "continuous" }}
								onPress={() => {
									methods.close();
									onTogglePin(item);
								}}
							>
								<HugeIcon
									icon={row.pinned ? PinOffIcon : PinIcon}
									size={20}
									color={colors.secondaryFg}
								/>
								<Text className="mt-1 font-sans-medium text-[12px] text-muted-foreground">
									{row.pinned ? "Unpin" : "Pin"}
								</Text>
							</Pressable>
						)
					: undefined
			}
			renderRightActions={(_, __, methods) => (
				<Pressable
					accessibilityRole="button"
					accessibilityLabel="Archive chat"
					className={cn(
						"w-24 items-center justify-center border-t border-danger/25 bg-danger/25",
						roundedTop && "rounded-tr-2xl",
						item.isLast && "rounded-br-2xl border-b",
					)}
					style={{ borderCurve: "continuous" }}
					onPress={() => {
						methods.close();
						void onArchive(item);
					}}
				>
					<HugeIcon icon={ArchiveIcon} size={20} color={colors.danger} />
					<Text className="mt-1 font-sans-medium text-[12px] text-danger">
						Archive
					</Text>
				</Pressable>
			)}
		>
			<Link href={href} asChild>
				<Link.Trigger>
					<Pressable
						className={cn(
							"min-h-[64px] flex-row items-center gap-2.5 border-x border-t border-border bg-card px-3 py-3 active:bg-muted",
							roundedTop && "rounded-t-2xl",
							item.isLast && "rounded-b-2xl border-b",
						)}
						style={{ borderCurve: "continuous" }}
					>
						{item.showProject ? (
							<ProjectLogo
								title={row.projectName}
								avatarUrl={avatarUrl}
								size={36}
							/>
						) : null}
						<View
							collapsable={false}
							className="w-4 items-center justify-center"
						>
							{row.pinned ? (
								<HugeIcon icon={PinIcon} size={12} color={colors.secondaryFg} />
							) : isActive ? (
								<PresenceDot tone="online" pulse size={7} />
							) : row.unread ? (
								<View className="h-[7px] w-[7px] rounded-full bg-primary" />
							) : null}
						</View>
						<View className="min-w-0 flex-1">
							<Text
								className={cn(
									"font-sans-medium text-[15px]",
									row.unread ? "text-foreground" : "text-muted-foreground",
								)}
								numberOfLines={1}
							>
								{row.title}
							</Text>
							<View className="mt-0.5 flex-row items-center gap-2">
								<Text
									className="min-w-0 flex-1 font-sans text-[12px] text-muted-foreground"
									numberOfLines={1}
								>
									{item.showProject ? `${row.projectName} · ` : ""}
									{row.threadLabel}
									{row.runningCount > 0 ? ` · ${row.runningCount} running` : ""}
									{row.threadCount > 1 ? ` · ${row.threadCount} threads` : ""}
									{row.subtitle.length > 0 ? ` · ${row.subtitle}` : ""}
								</Text>
								<BranchStateBadge state={branchState} />
							</View>
						</View>
						<HugeIcon
							icon={ArrowRight01Icon}
							size={16}
							color={colors.tertiaryFg}
						/>
					</Pressable>
				</Link.Trigger>
			</Link>
		</Swipeable>
	);
}
