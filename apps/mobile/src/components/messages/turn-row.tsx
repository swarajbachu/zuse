import {
	extractFileChanges,
	type FileChange,
	summarizeTurnActivity,
	type TimelineTurn,
} from "@zuse/client-runtime/timeline";
import type { Message } from "@zuse/contracts";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { ChevronDown, ChevronRight, Copy, Share2 } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Pressable, Share, Text, View } from "react-native";

import { colors } from "~/theme";
import { MessageRow, type MessageRowContext } from "./message-row";

const isNarrative = (message: Message): boolean =>
	message.content._tag === "assistant";

const isActivity = (message: Message): boolean =>
	message.content._tag === "thinking" ||
	message.content._tag === "tool_use" ||
	message.content._tag === "tool_result" ||
	message.content._tag === "context_compaction" ||
	message.content._tag === "subagent_summary";

const durationLabel = (durationMs: number): string => {
	if (durationMs < 1_000) return "Worked briefly";
	const seconds = Math.round(durationMs / 1_000);
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return minutes > 0
		? `Worked for ${minutes}m ${rest}s`
		: `Worked for ${rest}s`;
};

export function TurnRow({
	turn,
	context,
	live,
}: {
	turn: TimelineTurn;
	context: MessageRowContext;
	live: boolean;
}) {
	const [activityOpen, setActivityOpen] = useState(false);
	const [filesOpen, setFilesOpen] = useState(false);
	const activity = useMemo(() => summarizeTurnActivity(turn.body), [turn.body]);
	const narrative = turn.body.filter(isNarrative);
	const utility = turn.body.filter(
		(message) => !isNarrative(message) && !isActivity(message),
	);
	const activityMessages = turn.body.filter(isActivity);
	const assistantText = narrative
		.flatMap((message) =>
			message.content._tag === "assistant" ? [message.content.text] : [],
		)
		.join("\n\n");

	const fileTargets = useMemo(() => {
		const byPath = new Map<string, { file: FileChange; itemId: string }>();
		for (const message of turn.body) {
			const content = message.content;
			if (content._tag !== "tool_use") continue;
			for (const file of extractFileChanges(content.tool, content.input)) {
				const current = byPath.get(file.path);
				byPath.set(
					file.path,
					current === undefined
						? { file, itemId: content.itemId }
						: {
								...current,
								file: {
									...current.file,
									added: current.file.added + file.added,
									removed: current.file.removed + file.removed,
									lines: [...current.file.lines, ...file.lines],
								},
							},
				);
			}
		}
		return [...byPath.values()];
	}, [turn.body]);

	return (
		<View className="gap-1 py-1">
			{turn.user === null ? null : (
				<MessageRow message={turn.user} ctx={context} />
			)}
			{live
				? turn.body.map((message, index) => (
						<MessageRow
							key={message.id}
							message={message}
							ctx={context}
							isLast={index === turn.body.length - 1}
						/>
					))
				: null}
			{live
				? null
				: narrative.map((message) => (
						<MessageRow key={message.id} message={message} ctx={context} />
					))}
			{live
				? null
				: utility.map((message) => (
						<MessageRow key={message.id} message={message} ctx={context} />
					))}

			{!live && activityMessages.length > 0 ? (
				<View className="px-2 pt-1">
					<Pressable
						accessibilityRole="button"
						accessibilityState={{ expanded: activityOpen }}
						onPress={() => setActivityOpen((open) => !open)}
						className="min-h-11 flex-row items-center gap-2 py-2 active:opacity-60"
					>
						<Text className="font-sans text-[15px] text-muted-foreground">
							{durationLabel(turn.durationMs)}
						</Text>
						{activity.agents > 0 ? (
							<Text className="font-sans text-[13px] text-muted-foreground">
								· {activity.agents} {activity.agents === 1 ? "agent" : "agents"}
							</Text>
						) : null}
						<View className="flex-1" />
						{activityOpen ? (
							<ChevronDown size={16} color={colors.secondaryFg} />
						) : (
							<ChevronRight size={16} color={colors.secondaryFg} />
						)}
					</Pressable>
					{activityOpen ? (
						<View className="border-t border-border pt-1">
							{activityMessages.map((message) => (
								<MessageRow key={message.id} message={message} ctx={context} />
							))}
						</View>
					) : null}
				</View>
			) : null}

			{!live && fileTargets.length > 0 ? (
				<View className="px-2 pt-1">
					<Pressable
						accessibilityRole="button"
						accessibilityState={{ expanded: filesOpen }}
						onPress={() => setFilesOpen((open) => !open)}
						className="min-h-12 flex-row items-center rounded-2xl border border-border bg-card px-4 active:opacity-70"
						style={{ borderCurve: "continuous" }}
					>
						<Text className="font-sans-medium text-[14px] text-foreground">
							{fileTargets.length} {fileTargets.length === 1 ? "file" : "files"}{" "}
							changed
						</Text>
						<Text
							className="ml-3 font-mono text-[13px]"
							style={{ color: colors.diffAdded, fontVariant: ["tabular-nums"] }}
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
						{filesOpen ? (
							<ChevronDown size={17} color={colors.secondaryFg} />
						) : (
							<ChevronRight size={17} color={colors.secondaryFg} />
						)}
					</Pressable>
					{filesOpen ? (
						<View className="overflow-hidden rounded-b-2xl border-x border-b border-border bg-card">
							{fileTargets.map(({ file, itemId }) => (
								<Pressable
									key={file.path}
									accessibilityRole="button"
									accessibilityLabel={`Open diff for ${file.path}`}
									onPress={() =>
										router.push({
											pathname: "/c/[conn]/session/[sessionId]/tool/[itemId]",
											params: {
												conn: context.connectionKey,
												sessionId: context.sessionId,
												itemId,
												filePath: file.path,
											},
										})
									}
									className="min-h-12 flex-row items-center border-t border-border px-4 active:opacity-60"
								>
									<Text
										className="min-w-0 flex-1 font-mono text-[12px] text-foreground"
										numberOfLines={1}
									>
										{file.path}
									</Text>
									<Text style={{ color: colors.diffAdded }}>+{file.added}</Text>
									<Text className="ml-2" style={{ color: colors.diffRemoved }}>
										−{file.removed}
									</Text>
								</Pressable>
							))}
						</View>
					) : null}
				</View>
			) : null}

			{!live && assistantText.length > 0 ? (
				<View className="flex-row gap-1 px-2 pt-1">
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Copy response"
						hitSlop={8}
						className="h-11 w-11 items-center justify-center active:opacity-60"
						onPress={() => Clipboard.setStringAsync(assistantText)}
					>
						<Copy size={17} color={colors.secondaryFg} />
					</Pressable>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Share response"
						hitSlop={8}
						className="h-11 w-11 items-center justify-center active:opacity-60"
						onPress={() => Share.share({ message: assistantText })}
					>
						<Share2 size={17} color={colors.secondaryFg} />
					</Pressable>
				</View>
			) : null}
		</View>
	);
}
