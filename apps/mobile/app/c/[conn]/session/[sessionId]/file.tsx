import type { FolderId, FsFileContent, SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import { Stack, useLocalSearchParams } from "expo-router";
import { FileText } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, RefreshControl, ScrollView, Text, View } from "react-native";

import { FileIcon } from "~/components/ui/file-icon";
import {
	normalizeConnParam,
	optionsForConnection,
} from "~/lib/connection-params";
import { readWorkspaceFile } from "~/rpc/actions";
import { useConnectionsStore } from "~/store/connections";
import { selectSessionChat, useSessionsStore } from "~/store/sessions";
import { colors } from "~/theme";

const basename = (path: string) =>
	path.split("/").filter(Boolean).at(-1) ?? path;

const languageLabel = (path: string) => {
	const name = basename(path);
	const extension = name.includes(".") ? name.split(".").at(-1) : null;
	return extension?.toUpperCase() ?? "TEXT";
};

export default function WorkspaceFileScreen() {
	const {
		conn,
		sessionId,
		path: rawPath,
	} = useLocalSearchParams<{ conn: string; sessionId: string; path: string }>();
	const path = normalizeConnParam(rawPath);
	const connKey = normalizeConnParam(conn);
	const normalizedSessionId = normalizeConnParam(sessionId) as SessionId;
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
	const [file, setFile] = useState<typeof FsFileContent.Type | null>(null);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(
		async (refresh = false) => {
			if (options === null || folderId === undefined || path.length === 0) {
				setLoading(false);
				return;
			}
			if (refresh) setRefreshing(true);
			setError(null);
			try {
				setFile(
					await Effect.runPromise(
						readWorkspaceFile({
							connection: options,
							folderId,
							path,
							worktreeId,
						}),
					),
				);
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				setLoading(false);
				setRefreshing(false);
			}
		},
		[folderId, options, path, worktreeId],
	);

	useEffect(() => {
		void load();
	}, [load]);

	const lines = useMemo(
		() => (file?.kind === "text" ? file.content.split(/\r\n|\r|\n/) : []),
		[file],
	);

	return (
		<View className="flex-1 bg-background">
			<Stack.Screen
				options={{ title: basename(path), headerLargeTitle: false }}
			/>
			<View className="mx-4 mb-3 mt-2 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3.5 py-3">
				<View className="h-10 w-10 items-center justify-center rounded-xl bg-background">
					<FileIcon path={path} size={22} />
				</View>
				<View className="min-w-0 flex-1">
					<Text
						className="font-sans-medium text-[14px] text-foreground"
						numberOfLines={1}
					>
						{basename(path)}
					</Text>
					<Text
						className="mt-0.5 font-sans text-[11px] text-muted-foreground"
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{path}
					</Text>
				</View>
				{file !== null ? (
					<View className="items-end">
						<Text className="font-mono text-[11px] text-foreground">
							{languageLabel(path)}
						</Text>
						<Text className="mt-0.5 font-sans text-[10px] text-muted-foreground">
							{file.size.toLocaleString()} B
						</Text>
					</View>
				) : null}
			</View>

			{loading && file === null ? (
				<View className="mx-4 gap-2 rounded-2xl bg-card p-4">
					{[0, 1, 2, 3, 4, 5, 6, 7].map((index) => (
						<View
							key={index}
							className="h-4 rounded-md bg-muted"
							style={{ width: `${72 + (index % 3) * 8}%` }}
						/>
					))}
				</View>
			) : null}
			{error !== null ? (
				<View className="mx-4 rounded-2xl border border-danger/30 bg-danger/10 px-4 py-4">
					<Text className="font-sans text-[13px] leading-5 text-danger">
						{error}
					</Text>
				</View>
			) : null}
			{file?.kind === "binary" ? (
				<ScrollView
					contentInsetAdjustmentBehavior="automatic"
					refreshControl={
						<RefreshControl
							refreshing={refreshing}
							onRefresh={() => void load(true)}
						/>
					}
					contentContainerStyle={{ alignItems: "center", padding: 40 }}
				>
					<View className="h-12 w-12 items-center justify-center rounded-2xl bg-muted">
						<FileText size={23} color={colors.secondaryFg} />
					</View>
					<Text className="mt-4 font-sans-medium text-[15px] text-foreground">
						Preview unavailable
					</Text>
					<Text className="mt-1 text-center font-sans text-[13px] text-muted-foreground">
						This binary file can’t be displayed as text.
					</Text>
				</ScrollView>
			) : null}
			{file?.kind === "text" ? (
				<View className="mx-3 mb-3 min-h-0 flex-1 overflow-hidden rounded-2xl border border-border bg-card">
					<ScrollView horizontal showsHorizontalScrollIndicator>
						<FlatList
							style={{ minWidth: "100%" }}
							data={lines}
							keyExtractor={(_, index) => `${index}`}
							refreshControl={
								<RefreshControl
									refreshing={refreshing}
									onRefresh={() => void load(true)}
								/>
							}
							contentContainerStyle={{ paddingVertical: 8 }}
							initialNumToRender={80}
							maxToRenderPerBatch={100}
							windowSize={12}
							renderItem={({ item, index }) => (
								<View className="min-h-6 flex-row items-start">
									<Text
										className="w-12 pr-3 text-right font-mono text-[10px] leading-5 text-muted-foreground"
										style={{ fontVariant: ["tabular-nums"] }}
									>
										{index + 1}
									</Text>
									<Text
										selectable
										className="pr-5 font-mono text-[12px] leading-5 text-foreground"
									>
										{item.length === 0 ? " " : item}
									</Text>
								</View>
							)}
						/>
					</ScrollView>
				</View>
			) : null}
		</View>
	);
}
