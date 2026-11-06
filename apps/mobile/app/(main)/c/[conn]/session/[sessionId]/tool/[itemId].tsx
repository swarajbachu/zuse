import "@zuse/i18n/english/common";
import "@zuse/i18n/english/tools";
import { useAtomValue } from "@effect/atom-react";
import { loadDeferredSessionToolDetails } from "@zuse/client-runtime/session-message-detail";
import type { DiffLine, FileChange } from "@zuse/client-runtime/timeline";
import {
	GitReviewFile,
	GitReviewSummary,
	type MessageContent,
	type SessionId,
} from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";
import * as Clipboard from "expo-clipboard";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
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
import { useHeaderContentInset } from "~/lib/native-header";
import { prepareReviewLines } from "~/lib/review-diff-model";
import { connectionSessionKey } from "~/lib/session-key";
import { buildToolPresentation, toResultText } from "~/lib/tool-presentation";
import { useToolbarIcons } from "~/lib/toolbar-icons";
import { sessionMessagesAtom } from "~/store/messages";
import {
	loadMobileMessageDetail,
	mobileHistoryRef,
} from "~/store/mobile-client-bus";
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
	const { message: uiMessage } = useMessages(["common", "tools"]);
	const toolbarIcon = useToolbarIcons();
	const headerHeight = useHeaderContentInset();
	const { conn, sessionId, itemId, filePath } = useLocalSearchParams<{
		conn: string;
		sessionId: string;
		itemId: string;
		filePath?: string;
	}>();
	const key = connectionSessionKey(conn, sessionId as SessionId);
	const messages = useAtomValue(sessionMessagesAtom(key));
	const toolMessage = messages.find(
		(message) =>
			message.content._tag === "tool_use" && message.content.itemId === itemId,
	);
	const previewTool = toolMessage?.content as ToolUse | undefined;
	const resultMessage = messages.find(
		(message) =>
			message.content._tag === "tool_result" &&
			message.content.itemId === itemId,
	);
	const previewResult = resultMessage?.content as ToolResult | undefined;
	const detailKey =
		previewResult?.outputDeferred === undefined
			? null
			: JSON.stringify([
					conn,
					sessionId,
					toolMessage?.id,
					resultMessage?.id,
					previewResult?.outputDeferred,
				]);
	const [loaded, setLoaded] = useState<{
		key: string;
		output: ToolResult["output"];
	} | null>(null);
	const [detailError, setDetailError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const requestKey =
		detailKey === null ? null : JSON.stringify([detailKey, attempt]);
	useEffect(() => {
		if (
			detailKey === null ||
			toolMessage === undefined ||
			requestKey === null ||
			loaded?.key === detailKey
		)
			return;
		const ref = mobileHistoryRef(conn, sessionId as SessionId);
		if (ref === null) {
			setDetailError("Reconnect this conversation to load details.");
			return;
		}
		const controller = new AbortController();
		setDetailError(null);
		void loadDeferredSessionToolDetails(
			loadMobileMessageDetail,
			ref,
			toolMessage,
			resultMessage,
			controller.signal,
		).then(
			(details) => {
				if (!controller.signal.aborted)
					setLoaded({ key: detailKey, output: details.result?.output });
			},
			(error) => {
				if (!controller.signal.aborted)
					setDetailError(
						error instanceof Error
							? error.message
							: "Tool details are unavailable",
					);
			},
		);
		return () => controller.abort();
	}, [
		conn,
		sessionId,
		toolMessage,
		resultMessage,
		detailKey,
		requestKey,
		loaded?.key,
	]);
	const tool = previewTool;
	const result = useMemo(
		() =>
			detailKey !== null &&
			loaded?.key === detailKey &&
			previewResult !== undefined
				? { ...previewResult, output: loaded.output, outputDeferred: undefined }
				: previewResult,
		[detailKey, loaded, previewResult],
	);
	const presentation = useMemo(
		() => (tool === undefined ? null : buildToolPresentation(tool, result)),
		[result, tool],
	);
	const files = presentation?.fileChanges ?? [];
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
	const totalAdded = presentation?.fileChangeTotals?.added ?? 0;
	const totalRemoved = presentation?.fileChangeTotals?.removed ?? 0;
	const inlineReview = useMemo(
		() =>
			GitReviewSummary.make({
				scope: "branch",
				baseRef: null,
				headRef: null,
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

	if (detailKey !== null && loaded?.key !== detailKey)
		return (
			<View className="flex-1 items-center justify-center gap-3 bg-background px-6">
				<Stack.Screen options={{ title: "Tool details" }} />
				<Text accessibilityRole={detailError ? "alert" : "text"}>
					{detailError
						? uiMessage("tools:tool_row_error")
						: uiMessage("common:loading")}
				</Text>
				{detailError !== null ? (
					<Pressable
						accessibilityRole="button"
						onPress={() => setAttempt((value) => value + 1)}
					>
						<Text>{uiMessage("common:retry")}</Text>
					</Pressable>
				) : null}
			</View>
		);
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
					headerTitleStyle: { color: colors.fg },
				}}
			/>
			<Stack.Screen.Title>
				{hasFiles
					? `${files.length} file${files.length === 1 ? "" : "s"} changed`
					: presentation.label}
			</Stack.Screen.Title>
			<Stack.Toolbar placement="left">
				<Stack.Toolbar.Button
					icon={toolbarIcon("xmark")}
					separateBackground
					onPress={() => router.back()}
				/>
			</Stack.Toolbar>
			<Stack.Toolbar placement="right">
				<Stack.Toolbar.Button icon={toolbarIcon("doc.on.doc")} onPress={copy} />
				<Stack.Toolbar.Button
					icon={toolbarIcon("square.and.arrow.up")}
					onPress={share}
				/>
			</Stack.Toolbar>
			<View className="flex-1" style={{ paddingTop: headerHeight }}>
				{hasFiles ? (
					<>
						<View className="h-8 items-center justify-center border-b border-border">
							<Text
								className="font-mono text-[11px]"
								style={{ fontVariant: ["tabular-nums"] }}
							>
								<Text style={{ color: colors.diffAdded }}>+{totalAdded}</Text>
								<Text style={{ color: colors.secondaryFg }}> </Text>
								<Text style={{ color: colors.diffRemoved }}>
									−{totalRemoved}
								</Text>
							</Text>
						</View>
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

const diffText = (lines: readonly DiffLine[]): string =>
	lines
		.map((line) => {
			if (line.kind === "added") return `+${line.text}`;
			if (line.kind === "removed") return `-${line.text}`;
			if (line.kind === "hunk") return line.text;
			return ` ${line.text}`;
		})
		.join("\n");
