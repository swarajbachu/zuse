import type { FolderId, SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import {
	ChevronDown,
	ChevronRight,
	Folder,
	Search,
	X,
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	FlatList,
	Platform,
	Pressable,
	RefreshControl,
	Text,
	TextInput,
	useWindowDimensions,
	View,
} from "react-native";

import { ReviewDiffList } from "~/components/diff/review-diff-list";
import { FileIcon } from "~/components/ui/file-icon";
import { GlassSurface } from "~/components/ui/glass-surface";
import { useWorkspaceReview } from "~/hooks/use-workspace-review";
import {
	normalizeConnParam,
	optionsForConnection,
} from "~/lib/connection-params";
import { buildFileTree, flattenFileTree } from "~/lib/file-tree";
import { listWorkspacePaths } from "~/rpc/actions";
import { useConnectionsStore } from "~/store/connections";
import { selectSessionChat, useSessionsStore } from "~/store/sessions";
import { colors } from "~/theme";

type Tab = "modified" | "all";

export default function WorkspaceFilesScreen() {
	const { width } = useWindowDimensions();
	const headerHeight = useHeaderHeight();
	const {
		conn,
		sessionId,
		tab: rawTab,
	} = useLocalSearchParams<{
		conn: string;
		sessionId: string;
		tab?: string;
	}>();
	const connKey = normalizeConnParam(conn);
	const normalizedSessionId = normalizeConnParam(sessionId) as SessionId;
	const connections = useConnectionsStore((state) => state.connections);
	const bundles = useSessionsStore(
		(state) => state.bundlesByConnection[connKey] ?? [],
	);
	const detail = selectSessionChat(bundles, normalizedSessionId);
	const folderId = detail?.project.id as FolderId | undefined;
	const worktreeId = detail?.session.worktreeId ?? null;
	const projectName = detail?.project.name ?? "Files";
	const options = useMemo(
		() => optionsForConnection(connKey, connections),
		[connKey, connections],
	);
	const [tab, setTab] = useState<Tab>(
		rawTab === "modified" ? "modified" : "all",
	);
	const [paths, setPaths] = useState<readonly string[]>([]);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const [query, setQuery] = useState("");
	const [initialLoading, setInitialLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [truncated, setTruncated] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const review = useWorkspaceReview({
		connection: options,
		folderId,
		worktreeId,
		enabled: tab === "modified",
	});

	const load = useCallback(
		async (refresh = false) => {
			if (options === null || folderId === undefined) {
				setInitialLoading(false);
				return;
			}
			if (refresh) setRefreshing(true);
			setError(null);
			try {
				const result = await Effect.runPromise(
					listWorkspacePaths({
						connection: options,
						folderId,
						worktreeId,
					}),
				);
				setPaths(result.paths);
				setTruncated(result.truncated);
			} catch (cause) {
				setError(
					cause instanceof Error
						? cause.message
						: "This workspace could not be loaded.",
				);
			}
			setInitialLoading(false);
			setRefreshing(false);
		},
		[folderId, options, worktreeId],
	);

	useEffect(() => {
		void load();
	}, [load]);

	const tree = useMemo(() => buildFileTree(paths), [paths]);
	const visible = useMemo(
		() => flattenFileTree({ nodes: tree, expanded, query }),
		[expanded, query, tree],
	);
	return (
		<View className="flex-1 bg-background">
			<Stack.Screen
				options={{
					title: projectName,
					headerLargeTitle: false,
					headerTitle:
						tab === "modified" && review.summary !== null
							? () => (
									<View className="items-center">
										<Text className="font-sans-medium text-[15px] text-foreground">
											{review.summary?.files.length}{" "}
											{review.summary?.files.length === 1 ? "file" : "files"}{" "}
											changed
										</Text>
										<Text
											className="font-mono text-[11px]"
											style={{ fontVariant: ["tabular-nums"] }}
										>
											<Text style={{ color: colors.diffAdded }}>
												+{review.summary?.additions}
											</Text>
											<Text style={{ color: colors.secondaryFg }}> </Text>
											<Text style={{ color: colors.diffRemoved }}>
												−{review.summary?.deletions}
											</Text>
										</Text>
									</View>
								)
							: undefined,
				}}
			/>
			<Stack.Toolbar placement="bottom">
				{tab === "all" ? (
					<Stack.Toolbar.View separateBackground>
						<GlassSurface
							style={{
								width: Math.min(width - 36, 560),
								minHeight: 46,
								flexDirection: "row",
								alignItems: "center",
								gap: 9,
								paddingHorizontal: 14,
								paddingVertical: 8,
							}}
						>
							<Search size={17} color={colors.secondaryFg} />
							<TextInput
								accessibilityLabel="Search files"
								autoCapitalize="none"
								autoCorrect={false}
								className="min-h-7 min-w-0 flex-1 font-sans text-[16px] text-foreground"
								placeholder="Search files"
								placeholderTextColor={colors.tertiaryFg}
								returnKeyType="search"
								value={query}
								onChangeText={setQuery}
							/>
							{query.length > 0 ? (
								<Pressable
									accessibilityRole="button"
									accessibilityLabel="Clear file search"
									hitSlop={10}
									onPress={() => setQuery("")}
								>
									<X size={16} color={colors.secondaryFg} />
								</Pressable>
							) : null}
						</GlassSurface>
					</Stack.Toolbar.View>
				) : null}
			</Stack.Toolbar>

			<View className="flex-1" style={{ paddingTop: headerHeight }}>
				<FileTabs value={tab} onChange={setTab} />
				{tab === "all" ? (
					<FlatList
						data={visible}
						keyExtractor={(item) => item.node.path}
						contentInsetAdjustmentBehavior="never"
						keyboardDismissMode="on-drag"
						refreshControl={
							<RefreshControl
								refreshing={refreshing}
								tintColor={colors.accent}
								onRefresh={() => void load(true)}
							/>
						}
						contentContainerStyle={{
							paddingHorizontal: 16,
							paddingTop: 10,
							paddingBottom: 112,
						}}
						initialNumToRender={24}
						maxToRenderPerBatch={24}
						updateCellsBatchingPeriod={16}
						windowSize={9}
						removeClippedSubviews={Platform.OS === "android"}
						renderItem={({ item }) => {
							const open = expanded.has(item.node.path);
							return (
								<Pressable
									accessibilityRole="button"
									accessibilityLabel={item.node.path}
									accessibilityState={
										item.node.kind === "directory"
											? { expanded: open }
											: undefined
									}
									onPress={() => {
										if (item.node.kind === "directory") {
											setExpanded((current) => {
												const next = new Set(current);
												if (next.has(item.node.path))
													next.delete(item.node.path);
												else next.add(item.node.path);
												return next;
											});
											return;
										}
										router.push({
											pathname: "/c/[conn]/session/[sessionId]/file",
											params: {
												conn: connKey,
												sessionId: normalizedSessionId,
												path: item.node.path,
											},
										});
									}}
									className="min-h-[54px] flex-row items-center gap-3 rounded-xl px-2"
									style={{ paddingLeft: 8 + item.depth * 18 }}
								>
									<View className="w-4 items-center">
										{item.node.kind === "directory" ? (
											open ? (
												<ChevronDown size={14} color={colors.secondaryFg} />
											) : (
												<ChevronRight size={14} color={colors.secondaryFg} />
											)
										) : null}
									</View>
									{item.node.kind === "directory" ? (
										<Folder size={19} color={colors.accent} />
									) : (
										<FileIcon path={item.node.path} size={18} />
									)}
									<Text
										className="min-w-0 flex-1 font-sans-medium text-[15px] text-foreground"
										numberOfLines={1}
									>
										{item.node.name}
									</Text>
									{item.node.kind === "directory" ? (
										<Text
											className="pr-2 font-sans text-[11px] text-muted-foreground"
											style={{ fontVariant: ["tabular-nums"] }}
										>
											{item.node.children.length}
										</Text>
									) : null}
								</Pressable>
							);
						}}
						ListHeaderComponent={
							truncated ? (
								<Text className="px-2 pb-2 pt-1 font-sans text-xs text-muted-foreground">
									Showing the first 50,000 paths.
								</Text>
							) : null
						}
						ListEmptyComponent={
							<FileEmptyState
								loading={initialLoading}
								error={error}
								query={query}
								emptyLabel="No files found"
								emptyMessage="This workspace does not contain any visible files."
								onRetry={() => void load(true)}
							/>
						}
					/>
				) : (
					<ReviewDiffList
						summary={review.summary}
						patches={review.patches}
						loading={review.loading}
						error={review.error}
						refreshing={review.refreshing}
						onRefresh={review.refresh}
					/>
				)}
			</View>
		</View>
	);
}

function FileTabs({
	value,
	onChange,
}: {
	value: Tab;
	onChange: (tab: Tab) => void;
}) {
	return (
		<View className="mx-4 mb-2 mt-2 flex-row rounded-lg bg-muted p-0.5">
			{(["modified", "all"] as const).map((tab) => {
				const selected = tab === value;
				return (
					<Pressable
						key={tab}
						accessibilityRole="tab"
						accessibilityState={{ selected }}
						onPress={() => onChange(tab)}
						className="h-9 flex-1 items-center justify-center rounded-md"
						style={{
							borderCurve: "continuous",
							backgroundColor: selected ? colors.cardElevated : "transparent",
						}}
					>
						<Text
							className="font-sans-medium text-[13px]"
							style={{ color: selected ? colors.fg : colors.secondaryFg }}
						>
							{tab === "modified" ? "Modified" : "All files"}
						</Text>
					</Pressable>
				);
			})}
		</View>
	);
}

function FileEmptyState({
	loading,
	error,
	query = "",
	emptyLabel = "No changes yet",
	emptyMessage = "Workspace changes will appear here.",
	onRetry,
}: {
	loading: boolean;
	error: string | null;
	query?: string;
	emptyLabel?: string;
	emptyMessage?: string;
	onRetry: () => void;
}) {
	if (loading) {
		return (
			<View className="gap-3 px-2 py-4">
				{[0, 1, 2, 3, 4, 5].map((index) => (
					<View key={index} className="h-11 rounded-xl bg-muted/60" />
				))}
			</View>
		);
	}
	return (
		<View className="items-center px-5 py-16">
			<Text className="font-sans-medium text-[15px] text-foreground">
				{error !== null
					? "Files unavailable"
					: query.length > 0
						? "No matching files"
						: emptyLabel}
			</Text>
			<Text className="mt-1 text-center font-sans text-[13px] leading-5 text-muted-foreground">
				{error ??
					(query.length > 0 ? "Try another file name or path." : emptyMessage)}
			</Text>
			{error !== null ? (
				<Pressable
					accessibilityRole="button"
					onPress={onRetry}
					className="mt-4 min-h-11 items-center justify-center rounded-xl bg-primary px-4"
				>
					<Text className="font-sans-medium text-[14px] text-primary-foreground">
						Try again
					</Text>
				</Pressable>
			) : null}
		</View>
	);
}
