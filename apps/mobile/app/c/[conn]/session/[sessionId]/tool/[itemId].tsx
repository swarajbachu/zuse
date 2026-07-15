import {
	type DiffLine,
	extractFileChanges,
} from "@zuse/client-runtime/timeline";
import type { MessageContent, SessionId } from "@zuse/contracts";
import * as Clipboard from "expo-clipboard";
import { Stack, useLocalSearchParams } from "expo-router";
import { ChevronLeft, ChevronRight, Copy, Share2 } from "lucide-react-native";
import { useMemo, useState } from "react";
import {
	FlatList,
	Pressable,
	ScrollView,
	Share,
	Text,
	View,
} from "react-native";

import { connectionSessionKey } from "~/lib/session-key";
import { buildToolPresentation, toResultText } from "~/lib/tool-presentation";
import { useMobileMessagesStore } from "~/store/messages";
import { colors } from "~/theme";

type ToolUse = Extract<MessageContent, { _tag: "tool_use" }>;
type ToolResult = Extract<MessageContent, { _tag: "tool_result" }>;

const rawText = (tool: ToolUse, result: ToolResult | undefined): string => {
	const input = (() => {
		try {
			return JSON.stringify(tool.input, null, 2);
		} catch {
			return String(tool.input);
		}
	})();
	const output = result === undefined ? "" : toResultText(result.output);
	return output.length > 0 ? `${input}\n\n${output}` : input;
};

export default function ToolDetailScreen() {
	const { conn, sessionId, itemId, filePath } = useLocalSearchParams<{
		conn: string;
		sessionId: string;
		itemId: string;
		filePath?: string;
	}>();
	const key = connectionSessionKey(conn, sessionId as SessionId);
	const messages = useMobileMessagesStore(
		(state) => state.messagesBySession[key] ?? [],
	);
	const tool = messages.find(
		(message) =>
			message.content._tag === "tool_use" && message.content.itemId === itemId,
	)?.content as ToolUse | undefined;
	const result = messages.find(
		(message) =>
			message.content._tag === "tool_result" &&
			message.content.itemId === itemId,
	)?.content as ToolResult | undefined;
	const presentation = useMemo(
		() => (tool === undefined ? null : buildToolPresentation(tool, result)),
		[result, tool],
	);
	const files = useMemo(
		() => (tool === undefined ? [] : extractFileChanges(tool.tool, tool.input)),
		[tool],
	);
	const [fileIndex, setFileIndex] = useState(() => {
		if (filePath === undefined) return 0;
		return Math.max(
			0,
			files.findIndex((entry) => entry.path === filePath),
		);
	});
	const file = files[fileIndex];
	const text = tool === undefined ? "" : rawText(tool, result);

	const copy = () =>
		Clipboard.setStringAsync(file === undefined ? text : diffText(file.lines));
	const share = () =>
		Share.share({ message: file === undefined ? text : diffText(file.lines) });

	if (tool === undefined || presentation === null) {
		return (
			<View className="flex-1 items-center justify-center bg-background px-6">
				<Stack.Screen options={{ title: "Tool details" }} />
				<Text selectable className="text-center font-sans text-foreground">
					This tool call is no longer available in the local transcript.
				</Text>
			</View>
		);
	}

	return (
		<View className="flex-1 bg-background">
			<Stack.Screen
				options={{
					title: presentation.label,
					headerLargeTitle: false,
					headerRight: () => (
						<View className="flex-row">
							<HeaderButton label="Copy" onPress={copy} icon="copy" />
							<HeaderButton label="Share" onPress={share} icon="share" />
						</View>
					),
				}}
			/>
			{file !== undefined ? (
				<>
					<View className="gap-2 border-b border-border px-4 pb-3 pt-2">
						<Text
							selectable
							className="font-mono text-[12px] text-foreground"
							numberOfLines={2}
						>
							{file.path}
						</Text>
						<View className="flex-row items-center">
							<Text
								style={{
									color: colors.diffAdded,
									fontVariant: ["tabular-nums"],
								}}
							>
								+{file.added}
							</Text>
							<Text
								className="ml-2"
								style={{
									color: colors.diffRemoved,
									fontVariant: ["tabular-nums"],
								}}
							>
								−{file.removed}
							</Text>
							<View className="flex-1" />
							{files.length > 1 ? (
								<View className="flex-row items-center gap-1">
									<NavButton
										label="Previous file"
										disabled={fileIndex === 0}
										onPress={() =>
											setFileIndex((index) => Math.max(0, index - 1))
										}
										direction="previous"
									/>
									<Text
										className="px-2 font-sans text-[12px] text-muted-foreground"
										style={{ fontVariant: ["tabular-nums"] }}
									>
										{fileIndex + 1} of {files.length}
									</Text>
									<NavButton
										label="Next file"
										disabled={fileIndex === files.length - 1}
										onPress={() =>
											setFileIndex((index) =>
												Math.min(files.length - 1, index + 1),
											)
										}
										direction="next"
									/>
								</View>
							) : null}
						</View>
					</View>
					<ScrollView
						horizontal
						contentContainerStyle={{ minWidth: "100%" }}
						showsHorizontalScrollIndicator
					>
						<FlatList
							style={{ minWidth: "100%" }}
							data={file.lines}
							keyExtractor={(_, index) => `${file.path}:${index}`}
							contentInsetAdjustmentBehavior="automatic"
							renderItem={({ item }) => <DiffRow line={item} />}
							initialNumToRender={80}
							maxToRenderPerBatch={100}
							windowSize={12}
						/>
					</ScrollView>
				</>
			) : (
				<ScrollView
					contentInsetAdjustmentBehavior="automatic"
					contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 48 }}
				>
					<View
						className="rounded-2xl border border-border bg-card p-4"
						style={{ borderCurve: "continuous" }}
					>
						<Text className="font-sans-medium text-[13px] text-muted-foreground">
							{presentation.kind === "shell" ? "Shell" : "Input"}
						</Text>
						<ScrollView horizontal showsHorizontalScrollIndicator={false}>
							<Text
								selectable
								className="mt-3 font-mono text-[13px] leading-5 text-foreground"
							>
								{presentation.body}
							</Text>
						</ScrollView>
					</View>
					{presentation.resultBody === null ? null : (
						<View
							className="rounded-2xl border border-border bg-card p-4"
							style={{ borderCurve: "continuous" }}
						>
							<Text
								className="font-sans-medium text-[13px]"
								style={{
									color: presentation.isError
										? colors.danger
										: colors.secondaryFg,
								}}
							>
								{presentation.isError ? "Error" : "Output"}
							</Text>
							<ScrollView horizontal showsHorizontalScrollIndicator={false}>
								<Text
									selectable
									className="mt-3 font-mono text-[13px] leading-5 text-foreground"
								>
									{presentation.resultBody}
								</Text>
							</ScrollView>
						</View>
					)}
				</ScrollView>
			)}
		</View>
	);
}

function DiffRow({ line }: { line: DiffLine }) {
	const color =
		line.kind === "added"
			? colors.diffAdded
			: line.kind === "removed"
				? colors.diffRemoved
				: line.kind === "hunk"
					? colors.diffHunk
					: colors.fg;
	const prefix =
		line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " ";
	return (
		<View className="min-h-6 flex-row items-start px-3">
			<Text
				selectable
				className="w-16 font-mono text-[11px] text-muted-foreground"
				style={{ fontVariant: ["tabular-nums"] }}
			>
				{line.oldLine ?? ""} {line.newLine ?? ""}
			</Text>
			<Text
				selectable
				className="font-mono text-[12px] leading-5"
				style={{ color }}
			>
				{line.kind === "hunk" ? line.text : `${prefix}${line.text}`}
			</Text>
		</View>
	);
}

function HeaderButton({
	label,
	onPress,
	icon,
}: {
	label: string;
	onPress: () => void;
	icon: "copy" | "share";
}) {
	const Icon = icon === "copy" ? Copy : Share2;
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			className="h-11 w-11 items-center justify-center active:opacity-60"
			onPress={onPress}
		>
			<Icon size={19} color={colors.accent} />
		</Pressable>
	);
}

function NavButton({
	label,
	disabled,
	onPress,
	direction,
}: {
	label: string;
	disabled: boolean;
	onPress: () => void;
	direction: "previous" | "next";
}) {
	const Icon = direction === "previous" ? ChevronLeft : ChevronRight;
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			disabled={disabled}
			className="h-11 w-11 items-center justify-center active:opacity-60"
			style={{ opacity: disabled ? 0.3 : 1 }}
			onPress={onPress}
		>
			<Icon size={18} color={colors.secondaryFg} />
		</Pressable>
	);
}

const diffText = (lines: readonly DiffLine[]): string =>
	lines
		.map((line) => {
			if (line.kind === "added") return `+${line.text}`;
			if (line.kind === "removed") return `-${line.text}`;
			return line.text;
		})
		.join("\n");
