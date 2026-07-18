import {
	type DiffLine,
	extractFileChanges,
	type FileChange,
} from "@zuse/client-runtime/timeline";
import {
	GitReviewFile,
	GitReviewSummary,
	type MessageContent,
	type SessionId,
} from "@zuse/contracts";
import * as Clipboard from "expo-clipboard";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { Copy, Share2, X } from "lucide-react-native";
import { useMemo, useState } from "react";
import {
	FlatList,
	Pressable,
	ScrollView,
	Share,
	Text,
	View,
} from "react-native";
import { ReviewDiffList } from "~/components/diff/review-diff-list";
import { type FileTab, FileTabs } from "~/components/files/file-tabs";
import { FileIcon } from "~/components/ui/file-icon";
import { prepareReviewLines } from "~/lib/review-diff-model";
import { connectionSessionKey } from "~/lib/session-key";
import { selectSessionMessages } from "~/lib/session-messages";
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
	const headerHeight = useHeaderHeight();
	const { conn, sessionId, itemId, filePath } = useLocalSearchParams<{
		conn: string;
		sessionId: string;
		itemId: string;
		filePath?: string;
	}>();
	const key = connectionSessionKey(conn, sessionId as SessionId);
	const messages = useMobileMessagesStore((state) =>
		selectSessionMessages(state.messagesBySession, key),
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
	const [tab, setTab] = useState<FileTab>("modified");
	const file = files[fileIndex];
	const text = tool === undefined ? "" : rawText(tool, result);
	const totalAdded = files.reduce((sum, entry) => sum + entry.added, 0);
	const totalRemoved = files.reduce((sum, entry) => sum + entry.removed, 0);
	const inlineReview = useMemo(
		() =>
			GitReviewSummary.make({
				baseRef: null,
				baseSha: "",
				headSha: "",
				additions: totalAdded,
				deletions: totalRemoved,
				files: files.map((entry) =>
					GitReviewFile.make({
						path: entry.path,
						oldPath: null,
						kind: "modified",
						additions: entry.added,
						deletions: entry.removed,
						binary: false,
						conflict: false,
						hasUncommittedChanges: true,
					}),
				),
			}),
		[files, totalAdded, totalRemoved],
	);
	const inlinePatches = useMemo(
		() =>
			Object.fromEntries(
				files.map((entry) => [
					entry.path,
					prepareReviewLines(entry.path, entry.lines),
				]),
			),
		[files],
	);

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

	const hasFiles = files.length > 0;

	return (
		<View className="flex-1 bg-background">
			<Stack.Screen
				options={{
					headerLargeTitle: false,
					headerBackVisible: false,
					headerLeft: () => (
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Close"
							hitSlop={10}
							onPress={() => router.back()}
							className="h-9 w-9 items-center justify-center rounded-full bg-card active:opacity-70"
							style={{ borderCurve: "continuous" }}
						>
							<X size={19} color={colors.fg} />
						</Pressable>
					),
					headerTitle: () =>
						hasFiles ? (
							<View className="items-center">
								<Text className="font-sans-medium text-[15px] text-foreground">
									{files.length} file{files.length === 1 ? "" : "s"} changed
								</Text>
								<Text
									className="font-sans text-[12px]"
									style={{ fontVariant: ["tabular-nums"] }}
								>
									<Text style={{ color: colors.diffAdded }}>+{totalAdded}</Text>
									<Text style={{ color: colors.secondaryFg }}> </Text>
									<Text style={{ color: colors.diffRemoved }}>
										−{totalRemoved}
									</Text>
								</Text>
							</View>
						) : (
							<Text
								className="font-sans-medium text-[15px] text-foreground"
								numberOfLines={1}
							>
								{presentation.label}
							</Text>
						),
					headerRight: () => (
						<View className="flex-row">
							<HeaderButton label="Copy" onPress={copy} icon="copy" />
							<HeaderButton label="Share" onPress={share} icon="share" />
						</View>
					),
				}}
			/>
			<View className="flex-1" style={{ paddingTop: headerHeight }}>
				{hasFiles ? (
					<>
						<FileTabs value={tab} onChange={setTab} />
						{tab === "all" ? (
							<FlatList
								data={files}
								keyExtractor={(entry) => entry.path}
								contentInsetAdjustmentBehavior="never"
								contentContainerClassName="py-2"
								renderItem={({ item, index }) => (
									<FileListRow
										file={item}
										onPress={() => {
											setFileIndex(index);
											setTab("modified");
										}}
									/>
								)}
							/>
						) : (
							<ReviewDiffList
								summary={inlineReview}
								patches={inlinePatches}
								loading={false}
								error={null}
								refreshing={false}
							/>
						)}
					</>
				) : (
					<ScrollView
						contentInsetAdjustmentBehavior="never"
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
		</View>
	);
}

function FileListRow({
	file,
	onPress,
}: {
	file: FileChange;
	onPress: () => void;
}) {
	return (
		<Pressable
			accessibilityRole="button"
			onPress={onPress}
			className="min-h-[58px] flex-row items-center gap-3 px-5"
		>
			<FileIcon path={file.path} size={18} />
			<Text
				className="min-w-0 flex-1 font-mono text-[13px] text-foreground"
				numberOfLines={1}
				ellipsizeMode="middle"
			>
				{file.path}
			</Text>
			<Text
				className="font-mono text-[12px]"
				style={{ color: colors.diffAdded, fontVariant: ["tabular-nums"] }}
			>
				+{file.added}
			</Text>
			<Text
				className="font-mono text-[12px]"
				style={{ color: colors.diffRemoved, fontVariant: ["tabular-nums"] }}
			>
				−{file.removed}
			</Text>
		</Pressable>
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

const diffText = (lines: readonly DiffLine[]): string =>
	lines
		.map((line) => {
			if (line.kind === "added") return `+${line.text}`;
			if (line.kind === "removed") return `-${line.text}`;
			if (line.kind === "hunk") return line.text;
			return ` ${line.text}`;
		})
		.join("\n");
