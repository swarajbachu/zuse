import {
	type DiffLine,
	parseUnifiedPatch,
} from "@zuse/client-runtime/timeline";
import type {
	FolderId,
	GitDiffResult,
	GitReviewFile,
	GitReviewSummary,
	SessionId,
} from "@zuse/contracts";
import { Effect } from "effect";
import { Stack, useLocalSearchParams } from "expo-router";
import {
	ChevronDown,
	ChevronRight,
	GitCompareArrows,
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	FlatList,
	Pressable,
	RefreshControl,
	ScrollView,
	Text,
	View,
} from "react-native";

import { FileIcon } from "~/components/ui/file-icon";
import {
	normalizeConnParam,
	optionsForConnection,
} from "~/lib/connection-params";
import { loadWorkspaceDiff, loadWorkspaceReview } from "~/rpc/actions";
import { useConnectionsStore } from "~/store/connections";
import { selectSessionChat, useSessionsStore } from "~/store/sessions";
import { colors } from "~/theme";

export default function WorkspaceReviewScreen() {
	const {
		conn,
		sessionId,
		path: rawPath,
	} = useLocalSearchParams<{
		conn: string;
		sessionId: string;
		path?: string;
	}>();
	const connKey = normalizeConnParam(conn);
	const normalizedSessionId = normalizeConnParam(sessionId) as SessionId;
	const initialPath =
		rawPath === undefined ? null : normalizeConnParam(rawPath);
	const connections = useConnectionsStore((state) => state.connections);
	const bundles = useSessionsStore(
		(state) => state.bundlesByConnection[connKey] ?? [],
	);
	const detail = selectSessionChat(bundles, normalizedSessionId);
	const folderId = detail?.project.id as FolderId | undefined;
	const worktreeId = detail?.session.worktreeId ?? null;
	const options = useMemo(
		() => optionsForConnection(connKey, connections),
		[connKey, connections],
	);
	const [summary, setSummary] = useState<GitReviewSummary | null>(null);
	const [expanded, setExpanded] = useState<string | null>(initialPath);
	const [diffs, setDiffs] = useState<Readonly<Record<string, GitDiffResult>>>(
		{},
	);
	const [loadingPaths, setLoadingPaths] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const [diffErrors, setDiffErrors] = useState<
		Readonly<Record<string, string>>
	>({});
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const loadSummary = useCallback(
		async (refresh = false) => {
			if (options === null || folderId === undefined) {
				setLoading(false);
				return;
			}
			if (refresh) setRefreshing(true);
			setError(null);
			try {
				setSummary(
					await Effect.runPromise(
						loadWorkspaceReview({ connection: options, folderId, worktreeId }),
					),
				);
				if (refresh) {
					setDiffs({});
					setDiffErrors({});
				}
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				setLoading(false);
				setRefreshing(false);
			}
		},
		[folderId, options, worktreeId],
	);

	const loadDiff = useCallback(
		async (path: string, retry = false) => {
			if (
				options === null ||
				folderId === undefined ||
				diffs[path] !== undefined ||
				(!retry && diffErrors[path] !== undefined) ||
				loadingPaths.has(path)
			) {
				return;
			}
			setDiffErrors((current) => {
				if (current[path] === undefined) return current;
				const next = { ...current };
				delete next[path];
				return next;
			});
			setLoadingPaths((current) => new Set(current).add(path));
			try {
				const result = await Effect.runPromise(
					loadWorkspaceDiff({
						connection: options,
						folderId,
						path,
						worktreeId,
					}),
				);
				setDiffs((current) => ({ ...current, [path]: result }));
			} catch (cause) {
				setDiffErrors((current) => ({
					...current,
					[path]: cause instanceof Error ? cause.message : String(cause),
				}));
			} finally {
				setLoadingPaths((current) => {
					const next = new Set(current);
					next.delete(path);
					return next;
				});
			}
		},
		[diffErrors, diffs, folderId, loadingPaths, options, worktreeId],
	);

	useEffect(() => {
		void loadSummary();
	}, [loadSummary]);

	useEffect(() => {
		if (expanded !== null) void loadDiff(expanded);
	}, [expanded, loadDiff]);

	return (
		<View className="flex-1 bg-background">
			<Stack.Screen
				options={{ title: "Review changes", headerLargeTitle: false }}
			/>
			<FlatList
				data={summary?.files ?? []}
				keyExtractor={(file) => file.path}
				contentInsetAdjustmentBehavior="automatic"
				refreshControl={
					<RefreshControl
						refreshing={refreshing}
						tintColor={colors.accent}
						onRefresh={() => void loadSummary(true)}
					/>
				}
				contentContainerStyle={{ padding: 14, paddingBottom: 40, gap: 10 }}
				ListHeaderComponent={
					summary === null ? null : <ReviewHeader summary={summary} />
				}
				renderItem={({ item }) => {
					const open = expanded === item.path;
					return (
						<ReviewFileCard
							file={item}
							open={open}
							loading={loadingPaths.has(item.path)}
							diff={diffs[item.path]}
							error={diffErrors[item.path]}
							onRetry={() => void loadDiff(item.path, true)}
							onPress={() =>
								setExpanded((current) =>
									current === item.path ? null : item.path,
								)
							}
						/>
					);
				}}
				ListEmptyComponent={
					<View className="items-center px-5 py-16">
						{loading ? (
							<View className="w-full gap-3">
								{[0, 1, 2, 3].map((index) => (
									<View key={index} className="h-16 rounded-2xl bg-muted/60" />
								))}
							</View>
						) : (
							<>
								<Text className="font-sans-medium text-[15px] text-foreground">
									{error === null
										? "No changes to review"
										: "Review unavailable"}
								</Text>
								<Text className="mt-1 text-center font-sans text-[13px] text-muted-foreground">
									{error ?? "This workspace matches its base branch."}
								</Text>
							</>
						)}
					</View>
				}
			/>
		</View>
	);
}

function ReviewHeader({ summary }: { summary: GitReviewSummary }) {
	return (
		<View className="mb-3 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3.5">
			<View className="h-10 w-10 items-center justify-center rounded-xl bg-primary/15">
				<GitCompareArrows size={20} color={colors.accent} />
			</View>
			<View className="min-w-0 flex-1">
				<Text className="font-sans-medium text-[15px] text-foreground">
					{summary.files.length} {summary.files.length === 1 ? "file" : "files"}{" "}
					changed
				</Text>
				<Text className="mt-0.5 font-sans text-[11px] text-muted-foreground">
					{summary.baseRef === null
						? "Workspace changes"
						: `Compared with ${summary.baseRef}`}
				</Text>
			</View>
			<DiffStats additions={summary.additions} deletions={summary.deletions} />
		</View>
	);
}

function ReviewFileCard({
	file,
	open,
	loading,
	diff,
	error,
	onRetry,
	onPress,
}: {
	file: GitReviewFile;
	open: boolean;
	loading: boolean;
	diff?: GitDiffResult;
	error?: string;
	onRetry: () => void;
	onPress: () => void;
}) {
	const lines = diff === undefined ? [] : parseUnifiedPatch(diff.patch);
	return (
		<View
			className="overflow-hidden rounded-2xl border border-border bg-card"
			style={{ borderCurve: "continuous" }}
		>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={`${open ? "Collapse" : "Expand"} changes for ${file.path}`}
				accessibilityState={{ expanded: open }}
				onPress={onPress}
				className="min-h-[64px] flex-row items-center gap-3 px-3.5"
			>
				<FileIcon path={file.path} size={20} />
				<View className="min-w-0 flex-1">
					<Text
						className="font-sans-medium text-[14px] text-foreground"
						numberOfLines={1}
					>
						{file.path.split("/").at(-1)}
					</Text>
					<Text
						className="mt-0.5 font-sans text-[11px] text-muted-foreground"
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{file.path}
					</Text>
				</View>
				<DiffStats additions={file.additions} deletions={file.deletions} />
				{open ? (
					<ChevronDown size={15} color={colors.secondaryFg} />
				) : (
					<ChevronRight size={15} color={colors.secondaryFg} />
				)}
			</Pressable>
			{open ? (
				<View className="border-t border-border bg-background">
					{loading ? (
						<View className="gap-2 p-3">
							{[0, 1, 2, 3].map((index) => (
								<View key={index} className="h-5 rounded-md bg-muted/60" />
							))}
						</View>
					) : error !== undefined ? (
						<View className="items-start gap-3 px-4 py-4">
							<Text className="font-sans text-[12px] leading-5 text-danger">
								{error}
							</Text>
							<Pressable
								accessibilityRole="button"
								onPress={onRetry}
								className="min-h-11 items-center justify-center rounded-xl bg-primary px-4"
							>
								<Text className="font-sans-medium text-[13px] text-primary-foreground">
									Try again
								</Text>
							</Pressable>
						</View>
					) : diff?.mode === "binary" ? (
						<Text className="px-4 py-5 font-sans text-[13px] text-muted-foreground">
							Binary file changed — no text diff is available.
						</Text>
					) : lines.length === 0 ? (
						<Text className="px-4 py-5 font-sans text-[13px] text-muted-foreground">
							No text diff is available for this file.
						</Text>
					) : (
						<ScrollView horizontal showsHorizontalScrollIndicator>
							<View className="min-w-full py-1">
								{keyedDiffLines(lines).map(({ key, line }) => (
									<ReviewDiffRow key={key} line={line} />
								))}
							</View>
						</ScrollView>
					)}
					{diff?.truncated ? (
						<Text className="border-t border-border px-3 py-2 font-sans text-[11px] text-muted-foreground">
							Large diff truncated for mobile.
						</Text>
					) : null}
				</View>
			) : null}
		</View>
	);
}

function keyedDiffLines(lines: readonly DiffLine[]) {
	const occurrences = new Map<string, number>();
	return lines.map((line) => {
		const signature = `${line.kind}:${line.oldLine}:${line.newLine}:${line.text}`;
		const occurrence = occurrences.get(signature) ?? 0;
		occurrences.set(signature, occurrence + 1);
		return { key: `${signature}:${occurrence}`, line };
	});
}

function ReviewDiffRow({ line }: { line: DiffLine }) {
	if (line.kind === "hunk") {
		return (
			<View className="min-h-8 justify-center bg-primary/10 px-3">
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
			className="min-h-6 flex-row items-start"
			style={{
				backgroundColor: added
					? colors.diffAddedBg
					: removed
						? colors.diffRemovedBg
						: "transparent",
			}}
		>
			<View className="w-[72px] flex-row justify-end gap-2 border-r border-border/60 px-2 py-0.5">
				<Text className="w-5 text-right font-mono text-[10px] text-muted-foreground">
					{line.oldLine ?? ""}
				</Text>
				<Text className="w-5 text-right font-mono text-[10px] text-muted-foreground">
					{line.newLine ?? ""}
				</Text>
			</View>
			<Text
				selectable
				className="px-2 py-0.5 font-mono text-[11px] leading-5 text-foreground"
			>
				<Text
					style={{
						color: added
							? colors.diffAdded
							: removed
								? colors.diffRemoved
								: colors.secondaryFg,
					}}
				>
					{added ? "+" : removed ? "−" : " "}
				</Text>
				{line.text}
			</Text>
		</View>
	);
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
				className="font-mono text-[11px]"
				style={{ color: colors.diffAdded, fontVariant: ["tabular-nums"] }}
			>
				+{additions}
			</Text>
			<Text
				className="font-mono text-[11px]"
				style={{ color: colors.diffRemoved, fontVariant: ["tabular-nums"] }}
			>
				−{deletions}
			</Text>
		</View>
	);
}
