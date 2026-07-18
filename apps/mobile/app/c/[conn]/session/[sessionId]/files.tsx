import type { FolderId, SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { ChevronDown, ChevronRight, Folder, Search } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	ActivityIndicator,
	FlatList,
	Pressable,
	RefreshControl,
	Text,
	TextInput,
	View,
} from "react-native";

import { FileIcon } from "~/components/ui/file-icon";
import {
	normalizeConnParam,
	optionsForConnection,
} from "~/lib/connection-params";
import { buildFileTree, flattenFileTree } from "~/lib/file-tree";
import { listWorkspacePaths } from "~/rpc/actions";
import { useConnectionsStore } from "~/store/connections";
import { selectSessionChat, useSessionsStore } from "~/store/sessions";
import { colors } from "~/theme";

export default function WorkspaceFilesScreen() {
	const { conn, sessionId } = useLocalSearchParams<{
		conn: string;
		sessionId: string;
	}>();
	const connKey = normalizeConnParam(conn);
	const normalizedSessionId = normalizeConnParam(sessionId) as SessionId;
	const connections = useConnectionsStore((state) => state.connections);
	const bundles = useSessionsStore(
		(state) => state.bundlesByConnection[connKey] ?? [],
	);
	const detail = selectSessionChat(bundles, normalizedSessionId);
	const options = useMemo(
		() => optionsForConnection(connKey, connections),
		[connKey, connections],
	);
	const [paths, setPaths] = useState<readonly string[]>([]);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const [query, setQuery] = useState("");
	const [loading, setLoading] = useState(true);
	const [truncated, setTruncated] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		if (options === null || detail === null) return;
		setLoading(true);
		setError(null);
		try {
			const result = await Effect.runPromise(
				listWorkspacePaths({
					connection: options,
					folderId: detail.project.id as FolderId,
					worktreeId: detail.session.worktreeId,
				}),
			);
			setPaths(result.paths);
			setTruncated(result.truncated);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	}, [detail, options]);

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
			<Stack.Screen options={{ title: detail?.project.name ?? "Files" }} />
			<View className="mx-4 mb-2 mt-2 min-h-11 flex-row items-center gap-2 rounded-2xl bg-muted px-3">
				<Search size={17} color={colors.secondaryFg} />
				<TextInput
					value={query}
					onChangeText={setQuery}
					placeholder="Search files"
					placeholderTextColor={colors.secondaryFg}
					className="min-w-0 flex-1 py-2 font-sans text-[15px] text-foreground"
					clearButtonMode="while-editing"
					autoCapitalize="none"
					autoCorrect={false}
				/>
			</View>
			{truncated ? (
				<Text className="px-5 pb-2 font-sans text-xs text-muted-foreground">
					Showing the first 50,000 paths.
				</Text>
			) : null}
			<FlatList
				data={visible}
				keyExtractor={(item) => item.node.path}
				contentInsetAdjustmentBehavior="automatic"
				keyboardDismissMode="on-drag"
				refreshControl={
					<RefreshControl refreshing={loading} onRefresh={load} />
				}
				contentContainerStyle={{ paddingBottom: 24 }}
				renderItem={({ item }) => {
					const open = expanded.has(item.node.path);
					return (
						<Pressable
							accessibilityRole="button"
							accessibilityLabel={item.node.path}
							accessibilityState={
								item.node.kind === "directory" ? { expanded: open } : undefined
							}
							onPress={() => {
								if (item.node.kind === "directory") {
									setExpanded((current) => {
										const next = new Set(current);
										if (next.has(item.node.path)) next.delete(item.node.path);
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
							className="mx-2 min-h-11 flex-row items-center gap-2 rounded-xl px-2 active:bg-muted"
							style={{
								paddingLeft: 8 + item.depth * 18,
								borderCurve: "continuous",
							}}
						>
							{item.node.kind === "directory" ? (
								open ? (
									<ChevronDown size={13} color={colors.secondaryFg} />
								) : (
									<ChevronRight size={13} color={colors.secondaryFg} />
								)
							) : (
								<View className="w-[13px]" />
							)}
							{item.node.kind === "directory" ? (
								<Folder size={18} color={colors.secondaryFg} />
							) : (
								<FileIcon path={item.node.path} size={18} />
							)}
							<Text
								className="min-w-0 flex-1 font-sans-medium text-[14px] text-foreground"
								numberOfLines={1}
							>
								{item.node.name}
							</Text>
							{item.node.kind === "directory" ? (
								<Text className="font-sans text-[11px] text-muted-foreground">
									{item.node.children.length}
								</Text>
							) : null}
						</Pressable>
					);
				}}
				ListEmptyComponent={
					<View className="items-center px-5 py-12">
						{loading ? (
							<ActivityIndicator />
						) : (
							<>
								<Text className="font-sans-medium text-[15px] text-foreground">
									{error === null ? "No files found" : "Files unavailable"}
								</Text>
								<Text className="mt-1 text-center font-sans text-[13px] leading-5 text-muted-foreground">
									{error ?? "Try a different search."}
								</Text>
							</>
						)}
					</View>
				}
			/>
		</View>
	);
}
