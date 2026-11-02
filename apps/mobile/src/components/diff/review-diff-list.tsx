import type { DiffLine } from "@zuse/client-runtime/timeline";
import type { GitReviewFile, GitReviewSummary } from "@zuse/contracts";
import { Check, ChevronDown, ChevronRight } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type ListViewToken,
	type NativeScrollEvent,
	type NativeSyntheticEvent,
	Platform,
	Pressable,
	RefreshControl,
	SectionList,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { useUniwind } from "uniwind";

import { FileIcon } from "~/components/ui/file-icon";
import { cn } from "~/lib/cn";
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
	selectedPaths,
	onToggleSelection,
}: {
	summary: GitReviewSummary | null;
	patches: Readonly<Record<string, PreparedReviewPatch>>;
	loading: boolean;
	error: string | null;
	refreshing: boolean;
	onRefresh?: () => void;
	accordionKey?: number;
	allFilesExpanded?: boolean;
	selectedPaths?: ReadonlySet<string>;
	onToggleSelection?: (path: string) => void;
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
				selected={selectedPaths?.has(section.file.path)}
				onToggleSelection={onToggleSelection}
			/>
		),
		[onToggleSelection, selectedPaths, toggleFile],
	);

	const renderItem = useCallback(
		({ item }: { item: DiffRow }) => (
			<DiffDocumentRow item={item} palette={palette} />
		),
		[palette],
	);
	const onViewableItemsChanged = useRef(
		({ viewableItems }: { viewableItems: ListViewToken[] }) => {
			const firstVisibleRow = viewableItems.find(
				(token) => token.isViewable && token.item !== undefined,
			)?.item as DiffRow | undefined;
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
			const shouldPin = event.nativeEvent.contentOffset.y > 0;
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
				contentContainerStyle={{ paddingBottom: 40 }}
				renderSectionHeader={renderSectionHeader}
				renderSectionFooter={({ section }) =>
					section.expanded && section.data.length > 0 ? (
						<View className="h-4" />
					) : null
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
						selected={selectedPaths?.has(activeFile.path)}
						onToggleSelection={onToggleSelection}
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
	selected,
	onToggleSelection,
}: {
	file: GitReviewFile;
	expanded: boolean;
	pinned?: boolean;
	onPress: () => void;
	selected?: boolean;
	onToggleSelection?: (path: string) => void;
}) {
	const name = basename(file.path);
	const directory = dirname(file.path);
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${file.path}`}
			accessibilityState={{ expanded }}
			onPress={onPress}
			className={cn(
				"h-12 flex-row items-center gap-3 bg-background px-4",
				pinned && "bg-card",
			)}
			style={styles.fileHeader}
		>
			{onToggleSelection === undefined ? null : (
				<Pressable
					accessibilityRole="checkbox"
					accessibilityState={{ checked: selected === true }}
					accessibilityLabel={`Select ${file.path}`}
					hitSlop={12}
					onPress={(event) => {
						event.stopPropagation();
						onToggleSelection(file.path);
					}}
					className={cn(
						"h-[18px] w-[18px] items-center justify-center rounded-[5px]",
						selected ? "bg-primary" : "border-[1.5px] border-foreground/25",
					)}
				>
					{selected ? (
						<Check size={12} strokeWidth={3} color={colors.primaryForeground} />
					) : null}
				</Pressable>
			)}
			<FileIcon path={file.path} size={16} />
			<Text className="min-w-0 flex-1" numberOfLines={1}>
				<Text className="font-sans-medium text-[14px] text-foreground">
					{name}
				</Text>
				{directory.length > 0 ? (
					<Text className="font-sans text-[13px] text-muted-foreground">
						{"  "}
						{directory}
					</Text>
				) : null}
			</Text>
			<DiffStats additions={file.additions} deletions={file.deletions} />
			{expanded ? (
				<ChevronDown size={15} color={colors.tertiaryFg} />
			) : (
				<ChevronRight size={15} color={colors.tertiaryFg} />
			)}
		</Pressable>
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
			<View className="h-6 justify-center px-4">
				<View className="h-2.5 rounded bg-muted" style={{ width: "72%" }} />
			</View>
		);
	}
	if (item.kind === "error") {
		return (
			<View className="px-4 py-4">
				<Text className="font-sans text-[13px] leading-5 text-danger">
					{item.message}
				</Text>
			</View>
		);
	}
	if (item.kind === "empty" || item.kind === "truncated") {
		return (
			<View className="px-4 py-3">
				<Text className="font-sans text-[13px] text-muted-foreground">
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
			<View className="h-7 justify-center bg-foreground/[0.04] px-4">
				<Text
					selectable
					numberOfLines={1}
					className="font-mono text-[11px] text-muted-foreground"
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
			className="min-h-5 flex-row items-stretch"
			style={{
				backgroundColor: added
					? colors.diffAddedBg
					: removed
						? colors.diffRemovedBg
						: "transparent",
			}}
		>
			<View className="w-[64px] flex-row justify-end gap-1 pr-1 pl-2">
				<Text className="w-6 text-right font-mono text-[10px] leading-5 text-foreground-faint">
					{line.oldLine ?? ""}
				</Text>
				<Text className="w-6 text-right font-mono text-[10px] leading-5 text-foreground-faint">
					{line.newLine ?? ""}
				</Text>
			</View>
			<Text
				className="w-4 text-center font-mono text-[11px] leading-5"
				style={{
					color: added
						? colors.diffAdded
						: removed
							? colors.diffRemoved
							: "transparent",
				}}
			>
				{added ? "+" : removed ? "−" : " "}
			</Text>
			<Text
				selectable
				className="min-w-0 flex-1 pr-3 font-mono text-[11px] leading-5"
				style={{ color: palette.plain }}
			>
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
		<View className="flex-row gap-1.5">
			<Text
				className="font-mono text-[12px]"
				style={{ color: colors.diffAdded, fontVariant: ["tabular-nums"] }}
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
			<View className="px-4">
				{[0, 1, 2, 3].map((index) => (
					<View
						key={index}
						className="h-12 flex-row items-center gap-3"
						style={styles.fileHeader}
					>
						<View className="h-4 w-4 rounded bg-muted" />
						<View className="h-3 rounded bg-muted" style={{ width: "42%" }} />
					</View>
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
	fileHeader: {
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: colors.border,
	},
});
