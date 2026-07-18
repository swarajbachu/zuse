import type { DiffLine } from "@zuse/client-runtime/timeline";
import type { GitReviewFile, GitReviewSummary } from "@zuse/contracts";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type NativeScrollEvent,
	type NativeSyntheticEvent,
	Platform,
	Pressable,
	RefreshControl,
	SectionList,
	StyleSheet,
	Text,
	View,
	type ViewToken,
} from "react-native";
import { useUniwind } from "uniwind";

import { FileIcon } from "~/components/ui/file-icon";
import type { PreparedReviewPatch } from "~/lib/review-diff-model";
import {
	DARK_SYNTAX,
	LIGHT_SYNTAX,
	type SyntaxPalette,
	tokenizeCodeLine,
} from "~/lib/syntax-highlighting";
import { basename, dirname } from "~/lib/workspace-path";
import { colors } from "~/theme";

type DiffRow =
	| { key: string; kind: "line"; line: DiffLine; filePath: string }
	| { key: string; kind: "loading"; filePath: string }
	| { key: string; kind: "error"; message: string; filePath: string }
	| { key: string; kind: "empty"; message: string; filePath: string }
	| { key: string; kind: "truncated"; filePath: string };

type DiffSection = {
	file: GitReviewFile;
	expanded: boolean;
	data: readonly DiffRow[];
};

const patchRowsCache = new WeakMap<PreparedReviewPatch, readonly DiffRow[]>();

function rowsForPatch(
	file: GitReviewFile,
	patch: PreparedReviewPatch,
): readonly DiffRow[] {
	const cached = patchRowsCache.get(patch);
	if (cached !== undefined) return cached;
	let rows: DiffRow[];
	if (patch.error !== null) {
		rows = [
			{
				key: `${file.path}:error`,
				kind: "error",
				message: patch.error,
				filePath: file.path,
			},
		];
	} else if (patch.mode === "binary") {
		rows = [
			{
				key: `${file.path}:binary`,
				kind: "empty",
				message: "Binary file changed",
				filePath: file.path,
			},
		];
	} else {
		rows = patch.lines.map((line, index) => ({
			key: `${file.path}:line:${index}`,
			kind: "line",
			line,
			filePath: file.path,
		}));
		if (rows.length === 0) {
			rows.push({
				key: `${file.path}:empty`,
				kind: "empty",
				message: "No text diff available",
				filePath: file.path,
			});
		}
		if (patch.truncated) {
			rows.push({
				key: `${file.path}:truncated`,
				kind: "truncated",
				filePath: file.path,
			});
		}
	}
	patchRowsCache.set(patch, rows);
	return rows;
}

export function ReviewDiffList({
	summary,
	patches,
	loading,
	error,
	refreshing,
	onRefresh,
	accordionKey = 0,
	allFilesExpanded = true,
}: {
	summary: GitReviewSummary | null;
	patches: Readonly<Record<string, PreparedReviewPatch>>;
	loading: boolean;
	error: string | null;
	refreshing: boolean;
	onRefresh?: () => void;
	accordionKey?: number;
	allFilesExpanded?: boolean;
}) {
	const { theme } = useUniwind();
	const palette = theme === "dark" ? DARK_SYNTAX : LIGHT_SYNTAX;
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
	const [showPinnedHeader, setShowPinnedHeader] = useState(false);
	const activeFilePathRef = useRef<string | null>(null);
	const pinnedHeaderRef = useRef(false);
	const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 1 }).current;
	const sections = useMemo<readonly DiffSection[]>(() => {
		return (summary?.files ?? []).map((file) => {
			const expanded = !collapsed.has(file.path);
			if (!expanded) return { file, expanded, data: [] };
			const patch = patches[file.path];
			if (patch === undefined) {
				return {
					file,
					expanded,
					data: [0, 1, 2].map((index) => ({
						key: `${file.path}:loading:${index}`,
						kind: "loading" as const,
						filePath: file.path,
					})),
				};
			}
			return { file, expanded, data: rowsForPatch(file, patch) };
		});
	}, [collapsed, patches, summary]);
	useEffect(() => {
		if (accordionKey === 0) return;
		setCollapsed(
			allFilesExpanded
				? new Set()
				: new Set((summary?.files ?? []).map((file) => file.path)),
		);
	}, [accordionKey, allFilesExpanded, summary]);
	const activeFile = useMemo(
		() =>
			(summary?.files ?? []).find((file) => file.path === activeFilePath) ??
			summary?.files.at(0) ??
			null,
		[activeFilePath, summary],
	);
	const toggleFile = useCallback((path: string) => {
		setCollapsed((current) => {
			const next = new Set(current);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	}, []);

	const renderSectionHeader = useCallback(
		({ section }: { section: DiffSection }) => (
			<DiffFileHeader
				file={section.file}
				expanded={section.expanded}
				onPress={() => toggleFile(section.file.path)}
			/>
		),
		[toggleFile],
	);

	const renderItem = useCallback(
		({ item }: { item: DiffRow }) => (
			<DiffDocumentRow item={item} palette={palette} />
		),
		[palette],
	);
	const onViewableItemsChanged = useRef(
		({ viewableItems }: { viewableItems: ViewToken<DiffRow>[] }) => {
			const firstVisibleRow = viewableItems.find(
				(token) => token.isViewable && token.item !== undefined,
			)?.item;
			if (
				firstVisibleRow !== undefined &&
				firstVisibleRow.filePath !== activeFilePathRef.current
			) {
				activeFilePathRef.current = firstVisibleRow.filePath;
				setActiveFilePath(firstVisibleRow.filePath);
			}
		},
	).current;
	const onScroll = useCallback(
		(event: NativeSyntheticEvent<NativeScrollEvent>) => {
			const shouldPin = event.nativeEvent.contentOffset.y > 18;
			if (shouldPin === pinnedHeaderRef.current) return;
			pinnedHeaderRef.current = shouldPin;
			setShowPinnedHeader(shouldPin);
		},
		[],
	);
	const pinnedFileVisible =
		showPinnedHeader && activeFile !== null && !collapsed.has(activeFile.path);

	return (
		<View collapsable={false} className="flex-1">
			<SectionList
				className="flex-1"
				sections={sections}
				keyExtractor={(item) => item.key}
				contentInsetAdjustmentBehavior="never"
				stickySectionHeadersEnabled={false}
				initialNumToRender={64}
				maxToRenderPerBatch={64}
				updateCellsBatchingPeriod={16}
				windowSize={11}
				maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
				removeClippedSubviews={Platform.OS === "android"}
				onViewableItemsChanged={onViewableItemsChanged}
				viewabilityConfig={viewabilityConfig}
				onScroll={onScroll}
				scrollEventThrottle={32}
				refreshControl={
					onRefresh === undefined ? undefined : (
						<RefreshControl
							refreshing={refreshing}
							tintColor={colors.accent}
							onRefresh={onRefresh}
						/>
					)
				}
				contentContainerStyle={{ paddingTop: 18, paddingBottom: 40 }}
				renderSectionHeader={renderSectionHeader}
				renderSectionFooter={({ section }) =>
					section.expanded ? (
						<View className="h-7 bg-background" />
					) : (
						<View className="h-3" />
					)
				}
				renderItem={renderItem}
				ListEmptyComponent={
					<ReviewEmptyState loading={loading} error={error} />
				}
			/>
			{pinnedFileVisible && activeFile !== null ? (
				<View className="absolute inset-x-0 top-0" style={styles.pinnedHeader}>
					<DiffFileHeader
						file={activeFile}
						expanded
						pinned
						onPress={() => toggleFile(activeFile.path)}
					/>
				</View>
			) : null}
		</View>
	);
}

const DiffFileHeader = memo(function DiffFileHeader({
	file,
	expanded,
	pinned = false,
	onPress,
}: {
	file: GitReviewFile;
	expanded: boolean;
	pinned?: boolean;
	onPress: () => void;
}) {
	const name = basename(file.path);
	const directory = dirname(file.path);
	return (
		<View
			className={expanded || pinned ? "bg-background" : "bg-transparent px-4"}
		>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${file.path}`}
				accessibilityState={{ expanded }}
				onPress={onPress}
				className={
					pinned
						? "h-[52px] flex-row items-center gap-2.5 border-y border-border bg-card px-4"
						: expanded
							? "h-[64px] flex-row items-center gap-3 border-y border-border bg-card px-4 py-2.5"
							: "h-[70px] flex-row items-center gap-3 rounded-2xl bg-card px-4 py-3"
				}
				style={
					expanded || pinned
						? {
								borderTopWidth: StyleSheet.hairlineWidth,
								borderBottomWidth: StyleSheet.hairlineWidth,
							}
						: { borderCurve: "continuous" }
				}
			>
				<FileIcon path={file.path} size={pinned ? 18 : 21} />
				<View className="min-w-0 flex-1">
					<Text
						className="font-sans-medium text-[15px] text-foreground"
						numberOfLines={1}
					>
						{name}
					</Text>
					{!pinned && directory.length > 0 ? (
						<Text
							className="mt-1 font-sans text-[12px] text-muted-foreground"
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							{directory}
						</Text>
					) : null}
				</View>
				<DiffStats additions={file.additions} deletions={file.deletions} />
				{expanded ? (
					<ChevronDown size={16} color={colors.secondaryFg} />
				) : (
					<ChevronRight size={16} color={colors.secondaryFg} />
				)}
			</Pressable>
		</View>
	);
});

const DiffDocumentRow = memo(function DiffDocumentRow({
	item,
	palette,
}: {
	item: DiffRow;
	palette: SyntaxPalette;
}) {
	if (item.kind === "loading") {
		return (
			<View className="h-7 justify-center bg-card px-4">
				<View className="h-3 rounded bg-muted" style={{ width: "72%" }} />
			</View>
		);
	}
	if (item.kind === "error") {
		return (
			<View className="bg-card px-4 py-5">
				<Text className="font-sans text-[13px] leading-5 text-danger">
					{item.message}
				</Text>
			</View>
		);
	}
	if (item.kind === "empty" || item.kind === "truncated") {
		return (
			<View className="bg-card px-4 py-4">
				<Text className="font-sans text-[12px] text-muted-foreground">
					{item.kind === "truncated"
						? "Large diff truncated for mobile"
						: item.message}
				</Text>
			</View>
		);
	}
	return <DiffCodeRow line={item.line} palette={palette} />;
});

export const DiffCodeRow = memo(function DiffCodeRow({
	line,
	palette,
}: {
	line: DiffLine;
	palette: SyntaxPalette;
}) {
	if (line.kind === "hunk") {
		return (
			<View className="min-h-9 justify-center border-y border-border bg-card px-4 py-2">
				<Text
					selectable
					className="font-mono text-[11px]"
					style={{ color: colors.diffHunk }}
				>
					{line.text}
				</Text>
			</View>
		);
	}
	const added = line.kind === "added";
	const removed = line.kind === "removed";
	return (
		<View
			className="min-h-6 flex-row items-stretch bg-background"
			style={{
				backgroundColor: added
					? colors.diffAddedBg
					: removed
						? colors.diffRemovedBg
						: "transparent",
				borderLeftColor: added
					? colors.diffAdded
					: removed
						? colors.diffRemoved
						: "transparent",
				borderLeftWidth: added || removed ? 2 : 0,
			}}
		>
			<View className="w-[68px] flex-row justify-end gap-2 border-r border-border px-2 py-0.5">
				<Text className="w-5 text-right font-mono text-[10px] leading-5 text-muted-foreground">
					{line.oldLine ?? ""}
				</Text>
				<Text className="w-5 text-right font-mono text-[10px] leading-5 text-muted-foreground">
					{line.newLine ?? ""}
				</Text>
			</View>
			<Text
				selectable
				className="min-w-0 flex-1 px-2 py-0.5 font-mono text-[11px] leading-5"
				style={{ color: palette.plain }}
			>
				<Text
					style={{
						color: added
							? colors.diffAdded
							: removed
								? colors.diffRemoved
								: colors.tertiaryFg,
					}}
				>
					{added ? "+" : removed ? "−" : " "}
				</Text>
				<SyntaxLine text={line.text} palette={palette} />
			</Text>
		</View>
	);
});

function SyntaxLine({
	text,
	palette,
}: {
	text: string;
	palette: SyntaxPalette;
}) {
	return tokenizeCodeLine(text, palette).map((piece) => (
		<Text key={piece.key} style={{ color: piece.color }}>
			{piece.text}
		</Text>
	));
}

function DiffStats({
	additions,
	deletions,
}: {
	additions: number;
	deletions: number;
}) {
	return (
		<View className="flex-row gap-2">
			<Text
				className="font-mono text-[12px]"
				style={{ color: colors.accent, fontVariant: ["tabular-nums"] }}
			>
				+{additions}
			</Text>
			<Text
				className="font-mono text-[12px]"
				style={{ color: colors.diffRemoved, fontVariant: ["tabular-nums"] }}
			>
				−{deletions}
			</Text>
		</View>
	);
}

function ReviewEmptyState({
	loading,
	error,
}: {
	loading: boolean;
	error: string | null;
}) {
	if (loading) {
		return (
			<View className="gap-4 px-4 py-3">
				{[0, 1, 2, 3].map((index) => (
					<View key={index} className="h-[70px] rounded-2xl bg-card" />
				))}
			</View>
		);
	}
	return (
		<View className="items-center px-8 py-20">
			<Text className="font-sans-medium text-[15px] text-foreground">
				{error === null ? "No changes to review" : "Review unavailable"}
			</Text>
			<Text className="mt-2 text-center font-sans text-[13px] leading-5 text-muted-foreground">
				{error ?? "This workspace matches its base branch."}
			</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	pinnedHeader: {
		zIndex: 10,
		elevation: 3,
	},
});
