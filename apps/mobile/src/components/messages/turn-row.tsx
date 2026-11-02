import "@zuse/i18n/english/chat";
import { nativeBackgroundChildren } from "@zuse/client-runtime/native-background";
import {
	summarizeTurnActivity,
	type TimelineTurn,
} from "@zuse/client-runtime/timeline";
import type { Message } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { type ReactNode, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { InlineFileDiff } from "~/components/diff/inline-file-diff";
import { FileIcon } from "~/components/ui/file-icon";
import {
	countToolCalls,
	isToolActivity,
	segmentTurnBody,
} from "~/lib/tool-activity-tree";
import { workspaceDisplayPath } from "~/lib/workspace-path";
import { colors } from "~/theme";
import { MessageRow, type MessageRowContext } from "./message-row";
import { ToolActivityBranches, ToolActivityHeader } from "./tool-activity-tree";

const isNarrative = (message: Message): boolean =>
	message.content._tag === "assistant";

export function TurnRow({
	turn,
	context,
	live,
}: {
	turn: TimelineTurn;
	context: MessageRowContext;
	live: boolean;
}) {
	const { message: uiMessage } = useMessages(["chat"]);
	const background = useMemo(
		() => nativeBackgroundChildren(turn.body, context.executionSteps),
		[turn.body, context.executionSteps],
	);
	const [activityOpen, setActivityOpen] = useState(false);
	const [filesOpen, setFilesOpen] = useState(false);
	const [expandedFile, setExpandedFile] = useState<string | null>(null);
	const activity = useMemo(() => summarizeTurnActivity(turn.body), [turn.body]);
	const narrative = turn.body.filter(isNarrative);
	const utility = turn.body.filter(
		(message) => !isNarrative(message) && !isToolActivity(message),
	);
	const activityMessages = turn.body.filter(isToolActivity);
	const assistantText = narrative
		.flatMap((message) =>
			message.content._tag === "assistant" ? [message.content.text] : [],
		)
		.join("\n\n");

	const toolCount = countToolCalls(turn.body);
	const messageCount = turn.body.filter(
		(message) =>
			message.content._tag === "thinking" ||
			message.content._tag === "assistant",
	).length;

	const showSummary = !live && toolCount > 0 && assistantText.length > 0;
	const lastMessage = turn.body.at(-1);

	if (!showSummary) {
		return (
			<View className="gap-1 py-1">
				{turn.user === null ? null : (
					<MessageRow message={turn.user} ctx={context} />
				)}
				{live && background.size > 0 ? (
					<Text className="px-3 py-1 text-xs text-muted-foreground">
						{uiMessage("chat:native_background_running")}
					</Text>
				) : null}
				{segmentTurnBody(turn.body).map((segment) =>
					segment.kind === "message" ? (
						<MessageRow
							key={segment.message.id}
							message={segment.message}
							ctx={context}
							isLast={live && segment.message === lastMessage}
						/>
					) : (
						<LiveToolActivity
							key={segment.id}
							messages={segment.messages}
							toolCount={segment.toolCount}
							renderRow={(message) => (
								<MessageRow
									message={message}
									ctx={context}
									isLast={live && message === lastMessage}
								/>
							)}
						/>
					),
				)}
			</View>
		);
	}

	return (
		<View className="gap-1 py-1">
			{turn.user === null ? null : (
				<MessageRow message={turn.user} ctx={context} />
			)}

			<View className="px-2 pt-1">
				<ToolActivityHeader
					open={activityOpen}
					onToggle={() => setActivityOpen((open) => !open)}
					toolCount={toolCount}
					messageCount={messageCount}
				/>
				{activityOpen ? (
					<ToolActivityBranches
						messages={activityMessages}
						renderRow={(message) => (
							<MessageRow message={message} ctx={context} />
						)}
					/>
				) : null}
			</View>

			{utility.map((message) => (
				<MessageRow key={message.id} message={message} ctx={context} />
			))}
			{narrative.map((message) => (
				<MessageRow key={message.id} message={message} ctx={context} />
			))}

			{activity.files.length > 0 ? (
				<View className="px-2 pt-2">
					<Pressable
						accessibilityRole="button"
						accessibilityState={{ expanded: filesOpen }}
						onPress={() => setFilesOpen((open) => !open)}
						className="min-h-11 flex-row items-center gap-2 py-1 active:opacity-60"
					>
						{filesOpen ? (
							<ChevronDown size={14} color={colors.secondaryFg} />
						) : (
							<ChevronRight size={14} color={colors.secondaryFg} />
						)}
						<Text className="font-sans-medium text-[13px] text-muted-foreground">
							{activity.files.length}{" "}
							{activity.files.length === 1 ? "file" : "files"} changed
						</Text>
						<Text
							className="ml-3 font-mono text-[13px]"
							style={{ color: colors.accent, fontVariant: ["tabular-nums"] }}
						>
							+{activity.added}
						</Text>
						<Text
							className="ml-1 font-mono text-[13px]"
							style={{
								color: colors.diffRemoved,
								fontVariant: ["tabular-nums"],
							}}
						>
							−{activity.removed}
						</Text>
						<View className="flex-1" />
					</Pressable>
					{filesOpen ? (
						<View className="overflow-hidden rounded-2xl border border-border bg-card">
							{activity.files.map((file) => (
								<View key={file.path}>
									<Pressable
										key={file.path}
										accessibilityRole="button"
										accessibilityLabel={`${expandedFile === file.path ? "Collapse" : "Expand"} changes for ${file.path}`}
										accessibilityState={{
											expanded: expandedFile === file.path,
										}}
										onPress={() =>
											setExpandedFile((current) =>
												current === file.path ? null : file.path,
											)
										}
										className="min-h-12 flex-row items-center gap-2 px-3 active:opacity-60"
									>
										<FileIcon path={file.path} size={17} />
										<Text
											className="min-w-0 flex-1 font-mono text-[12px] text-foreground"
											numberOfLines={1}
										>
											{workspaceDisplayPath(file.path, context.workspaceRoot)}
										</Text>
										<Text
											className="font-mono text-[11px]"
											style={{ color: colors.accent }}
										>
											+{file.added}
										</Text>
										<Text
											className="font-mono text-[11px]"
											style={{ color: colors.diffRemoved }}
										>
											−{file.removed}
										</Text>
										{expandedFile === file.path ? (
											<ChevronDown size={12} color={colors.secondaryFg} />
										) : (
											<ChevronRight size={12} color={colors.secondaryFg} />
										)}
									</Pressable>
									{expandedFile === file.path ? (
										<View
											className="overflow-hidden border-t border-border bg-background"
											style={{ borderCurve: "continuous" }}
										>
											<InlineFileDiff lines={file.lines} />
										</View>
									) : null}
								</View>
							))}
						</View>
					) : null}
				</View>
			) : null}
		</View>
	);
}

/** Running work stays open so new tool calls grow the tree as they arrive. */
function LiveToolActivity({
	messages,
	toolCount,
	renderRow,
}: {
	messages: readonly Message[];
	toolCount: number;
	renderRow: (message: Message) => ReactNode;
}) {
	const [open, setOpen] = useState(true);
	return (
		<View className="px-2">
			<ToolActivityHeader
				open={open}
				onToggle={() => setOpen((value) => !value)}
				toolCount={toolCount}
			/>
			{open ? (
				<ToolActivityBranches messages={messages} renderRow={renderRow} />
			) : null}
		</View>
	);
}
