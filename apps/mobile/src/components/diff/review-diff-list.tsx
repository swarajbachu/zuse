import {
	type DiffLine,
	parseUnifiedPatch,
} from "@zuse/client-runtime/timeline";
import type {
	GitReviewFile,
	GitReviewPatch,
	GitReviewSummary,
} from "@zuse/contracts";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { memo, useCallback, useMemo, useState } from "react";
import {
	Pressable,
	RefreshControl,
	SectionList,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { useUniwind } from "uniwind";

import { FileIcon } from "~/components/ui/file-icon";
import { colors } from "~/theme";

type DiffRow =
	| { key: string; kind: "line"; line: DiffLine }
	| { key: string; kind: "loading" }
	| { key: string; kind: "error"; message: string }
	| { key: string; kind: "empty"; message: string }
	| { key: string; kind: "truncated" };

type DiffSection = {
	file: GitReviewFile;
	expanded: boolean;
	data: readonly DiffRow[];
};

type SyntaxPalette = {
	comment: string;
	keyword: string;
	literal: string;
	number: string;
	plain: string;
	string: string;
};

const LIGHT_SYNTAX: SyntaxPalette = {
	comment: "#71806d",
	keyword: "#9b32a8",
	literal: "#b04452",
	number: "#9c6429",
	plain: "#252622",
	string: "#56852f",
};

const DARK_SYNTAX: SyntaxPalette = {
	comment: "#7f8b7b",
	keyword: "#d66ee4",
	literal: "#f26d78",
	number: "#d89958",
	plain: "#d3d6cd",
	string: "#9ac66d",
};

const TOKEN_PATTERN =
	/(\/\/.*$|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:async|await|break|case|catch|class|const|continue|default|else|export|extends|false|finally|for|from|function|if|implements|import|in|interface|let|new|null|of|return|switch|throw|true|try|type|typeof|undefined|while|yield)\b|\b\d+(?:\.\d+)?\b)/g;

const patchRowsCache = new WeakMap<object, readonly DiffRow[]>();

function rowsForPatch(
	file: GitReviewFile,
	patch: GitReviewPatch,
): readonly DiffRow[] {
	const cached = patchRowsCache.get(patch);
	if (cached !== undefined) return cached;
	let rows: DiffRow[];
	if (patch.error !== null) {
		rows = [{ key: `${file.path}:error`, kind: "error", message: patch.error }];
	} else if (patch.result.mode === "binary") {
		rows = [
			{
				key: `${file.path}:binary`,
				kind: "empty",
				message: "Binary file changed",
			},
		];
	} else {
		rows = parseUnifiedPatch(patch.result.patch).map((line, index) => ({
			key: `${file.path}:line:${index}`,
			kind: "line",
			line,
		}));
		if (rows.length === 0) {
			rows.push({
				key: `${file.path}:empty`,
				kind: "empty",
				message: "No text diff available",
			});
		}
		if (patch.result.truncated) {
			rows.push({ key: `${file.path}:truncated`, kind: "truncated" });
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
}: {
	summary: GitReviewSummary | null;
	patches: Readonly<Record<string, GitReviewPatch>>;
	loading: boolean;
	error: string | null;
	refreshing: boolean;
	onRefresh?: () => void;
}) {
	const { theme } = useUniwind();
	const palette = theme === "dark" ? DARK_SYNTAX : LIGHT_SYNTAX;
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
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
					})),
				};
			}
			return { file, expanded, data: rowsForPatch(file, patch) };
		});
	}, [collapsed, patches, summary]);

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

	return (
		<SectionList
			className="flex-1"
			sections={sections}
			keyExtractor={(item) => item.key}
			contentInsetAdjustmentBehavior="automatic"
			stickySectionHeadersEnabled
			initialNumToRender={48}
			maxToRenderPerBatch={48}
			updateCellsBatchingPeriod={16}
			windowSize={7}
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
			ListEmptyComponent={<ReviewEmptyState loading={loading} error={error} />}
		/>
	);
}

const DiffFileHeader = memo(function DiffFileHeader({
	file,
	expanded,
	onPress,
}: {
	file: GitReviewFile;
	expanded: boolean;
	onPress: () => void;
}) {
	const name = file.path.split("/").at(-1) ?? file.path;
	const directory = file.path.slice(
		0,
		Math.max(0, file.path.length - name.length - 1),
	);
	return (
		<View className={expanded ? "bg-background" : "bg-transparent px-4"}>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${file.path}`}
				accessibilityState={{ expanded }}
				onPress={onPress}
				className={
					expanded
						? "min-h-[74px] flex-row items-center gap-3 border-y border-border bg-card px-4 py-3"
						: "min-h-[70px] flex-row items-center gap-3 rounded-2xl bg-card px-4 py-3"
				}
				style={
					expanded
						? {
								borderTopWidth: StyleSheet.hairlineWidth,
								borderBottomWidth: StyleSheet.hairlineWidth,
							}
						: { borderCurve: "continuous" }
				}
			>
				<FileIcon path={file.path} size={21} />
				<View className="min-w-0 flex-1">
					<Text
						className="font-sans-medium text-[15px] text-foreground"
						numberOfLines={1}
					>
						{name}
					</Text>
					{directory.length > 0 ? (
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

const DiffCodeRow = memo(function DiffCodeRow({
	line,
	palette,
}: {
	line: DiffLine;
	palette: SyntaxPalette;
}) {
	if (line.kind === "hunk") {
		return (
			<View className="min-h-9 justify-center border-y border-border bg-card px-4">
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
			className="min-h-[24px] flex-row items-start bg-background"
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
				numberOfLines={1}
				ellipsizeMode="clip"
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
	const pieces: { key: string; text: string; color: string }[] = [];
	let cursor = 0;
	for (const match of text.matchAll(TOKEN_PATTERN)) {
		const index = match.index ?? cursor;
		if (index > cursor)
			pieces.push({
				key: `${cursor}:plain`,
				text: text.slice(cursor, index),
				color: palette.plain,
			});
		const token = match[0];
		const color =
			token.startsWith("//") || token.startsWith("/*")
				? palette.comment
				: token.startsWith('"') ||
						token.startsWith("'") ||
						token.startsWith("`")
					? palette.string
					: /^\d/.test(token)
						? palette.number
						: /^(?:true|false|null|undefined)$/.test(token)
							? palette.literal
							: palette.keyword;
		pieces.push({ key: `${index}:token`, text: token, color });
		cursor = index + token.length;
	}
	if (cursor < text.length)
		pieces.push({
			key: `${cursor}:plain`,
			text: text.slice(cursor),
			color: palette.plain,
		});
	return pieces.map((piece) => (
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
