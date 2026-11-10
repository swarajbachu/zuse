import type { Message } from "@zuse/contracts";
import {
	ChevronDown,
	ChevronRight,
	MessageSquare,
	Wrench,
} from "lucide-react-native";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";

import {
	type ToolTreePosition,
	toolTreePositions,
} from "~/lib/tool-activity-tree";
import { colors } from "~/theme";

/** The trunk sits under the disclosure chevron, matching the desktop tree. */
const TRUNK_INSET = 8;
const ELBOW_WIDTH = 8;
const ELBOW_HEIGHT = 15;
const LINE = 1;

export function ToolActivityHeader({
	open,
	onToggle,
	toolCount,
	messageCount = 0,
}: {
	open: boolean;
	onToggle: () => void;
	toolCount: number;
	messageCount?: number;
}) {
	const Chevron = open ? ChevronDown : ChevronRight;
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityState={{ expanded: open }}
			onPress={onToggle}
			hitSlop={8}
			className="flex-row items-center gap-3 py-1 active:opacity-60"
		>
			<Chevron size={16} color={colors.secondaryFg} />
			<View className="flex-row items-center gap-1.5">
				<Wrench size={13} color={colors.secondaryFg} />
				<Text
					className="font-sans text-[13px] text-muted-foreground"
					style={{ fontVariant: ["tabular-nums"] }}
				>
					{toolCount} {toolCount === 1 ? "tool call" : "tool calls"}
				</Text>
			</View>
			{messageCount > 0 ? (
				<View className="flex-row items-center gap-1.5">
					<MessageSquare size={13} color={colors.secondaryFg} />
					<Text
						className="font-sans text-[13px] text-muted-foreground"
						style={{ fontVariant: ["tabular-nums"] }}
					>
						{messageCount}
					</Text>
				</View>
			) : null}
		</Pressable>
	);
}

/** A trunk line with a rounded elbow into each branch; the last branch ends the trunk. */
function ToolTreeBranch({
	position,
	children,
}: {
	position: ToolTreePosition;
	children: ReactNode;
}) {
	if (position === null) return <View>{children}</View>;
	return (
		<View style={{ paddingLeft: TRUNK_INSET + ELBOW_WIDTH }}>
			{position !== "last" ? (
				<View
					pointerEvents="none"
					style={{
						position: "absolute",
						left: TRUNK_INSET,
						top: 0,
						bottom: 0,
						width: LINE,
						backgroundColor: colors.border,
					}}
				/>
			) : null}
			{position === "through" ? null : (
				<View
					pointerEvents="none"
					style={{
						position: "absolute",
						left: TRUNK_INSET,
						top: 0,
						width: ELBOW_WIDTH,
						height: ELBOW_HEIGHT,
						borderLeftWidth: LINE,
						borderBottomWidth: LINE,
						borderBottomLeftRadius: ELBOW_WIDTH,
						borderColor: colors.border,
					}}
				/>
			)}
			{children}
		</View>
	);
}

/** Activity rows hanging off the "N tool calls" header. */
export function ToolActivityBranches({
	messages,
	renderRow,
}: {
	messages: readonly Message[];
	renderRow: (message: Message) => ReactNode;
}) {
	const positions = useMemo(() => toolTreePositions(messages), [messages]);
	return (
		<View>
			{messages.map((message) => (
				<ToolTreeBranch
					key={message.id}
					position={positions.get(message.id) ?? null}
				>
					{renderRow(message)}
				</ToolTreeBranch>
			))}
		</View>
	);
}
