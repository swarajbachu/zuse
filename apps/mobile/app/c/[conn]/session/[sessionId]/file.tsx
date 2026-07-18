import type { FolderId, FsFileContent, SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	ActivityIndicator,
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
import { readWorkspaceFile } from "~/rpc/actions";
import { useConnectionsStore } from "~/store/connections";
import { selectSessionChat, useSessionsStore } from "~/store/sessions";

const basename = (path: string) =>
	path.split("/").filter(Boolean).at(-1) ?? path;

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
	const options = useMemo(
		() => optionsForConnection(connKey, connections),
		[connKey, connections],
	);
	const [file, setFile] = useState<typeof FsFileContent.Type | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		if (options === null || detail === null || path.length === 0) return;
		setLoading(true);
		setError(null);
		try {
			setFile(
				await Effect.runPromise(
					readWorkspaceFile({
						connection: options,
						folderId: detail.project.id as FolderId,
						path,
						worktreeId: detail.session.worktreeId,
					}),
				),
			);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	}, [detail, options, path]);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<View className="flex-1 bg-background">
			<Stack.Screen
				options={{ title: basename(path), headerLargeTitle: false }}
			/>
			<View className="flex-row items-center gap-2 border-b border-border px-4 py-2">
				<FileIcon path={path} size={18} />
				<Text
					className="min-w-0 flex-1 font-mono text-[12px] text-muted-foreground"
					numberOfLines={1}
				>
					{path}
				</Text>
				{file !== null ? (
					<Text className="font-sans text-[11px] text-muted-foreground">
						{file.size.toLocaleString()} B
					</Text>
				) : null}
			</View>
			<ScrollView
				contentInsetAdjustmentBehavior="automatic"
				refreshControl={
					<RefreshControl refreshing={loading} onRefresh={load} />
				}
				contentContainerStyle={{ flexGrow: 1 }}
			>
				{loading && file === null ? (
					<View className="flex-1 items-center justify-center py-16">
						<ActivityIndicator />
					</View>
				) : null}
				{error !== null ? (
					<View className="px-5 py-12">
						<Text className="text-center font-sans text-[14px] leading-5 text-danger">
							{error}
						</Text>
					</View>
				) : null}
				{file?.kind === "binary" ? (
					<View className="items-center px-5 py-16">
						<Text className="font-sans-medium text-[15px] text-foreground">
							Preview unavailable
						</Text>
						<Text className="mt-1 text-center font-sans text-[13px] text-muted-foreground">
							This binary file can’t be displayed as text.
						</Text>
					</View>
				) : null}
				{file?.kind === "text" ? (
					<ScrollView horizontal contentContainerStyle={{ padding: 16 }}>
						<Text
							selectable
							className="font-mono text-[12px] leading-5 text-foreground"
						>
							{file.content.length === 0 ? "(empty file)" : file.content}
						</Text>
					</ScrollView>
				) : null}
			</ScrollView>
		</View>
	);
}
