import type { FolderId, FsFileContent, SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import { Stack, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { FileText } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	FlatList,
	Platform,
	RefreshControl,
	ScrollView,
	Text,
	useWindowDimensions,
	View,
} from "react-native";
import { useUniwind } from "uniwind";

import {
	normalizeConnParam,
	optionsForConnection,
} from "~/lib/connection-params";
import { selectConnectionBundles } from "~/lib/session-bundles";
import {
	DARK_SYNTAX,
	LIGHT_SYNTAX,
	tokenizeCodeLine,
} from "~/lib/syntax-highlighting";
import { readWorkspaceFile } from "~/rpc/actions";
import { useConnectionsStore } from "~/store/connections";
import { selectSessionChat, useSessionsStore } from "~/store/sessions";
import { colors } from "~/theme";

const basename = (path: string) =>
	path.split("/").filter(Boolean).at(-1) ?? path;

export default function WorkspaceFileScreen() {
	const headerHeight = useHeaderHeight();
	const { width } = useWindowDimensions();
	const { theme } = useUniwind();
	const syntaxPalette = theme === "dark" ? DARK_SYNTAX : LIGHT_SYNTAX;
	const {
		conn,
		sessionId,
		path: rawPath,
	} = useLocalSearchParams<{ conn: string; sessionId: string; path: string }>();
	const path = normalizeConnParam(rawPath);
	const connKey = normalizeConnParam(conn);
	const normalizedSessionId = normalizeConnParam(sessionId) as SessionId;
	const connections = useConnectionsStore((state) => state.connections);
	const bundles = useSessionsStore((state) =>
		selectConnectionBundles(state.bundlesByConnection, connKey),
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
	const codeWidth = useMemo(() => {
		const longestLine = lines.reduce(
			(longest, line) =>
				Math.max(longest, line.replaceAll("\t", "    ").length),
			0,
		);
		return Math.max(width - 24, 68 + Math.min(longestLine, 4_000) * 7.4);
	}, [lines, width]);

	return (
		<View className="flex-1 bg-background">
			<Stack.Screen
				options={{
					headerLargeTitle: false,
				}}
			/>
			<Stack.Screen.Title>{basename(path)}</Stack.Screen.Title>
			<View className="flex-1" style={{ paddingTop: headerHeight }}>
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
						contentInsetAdjustmentBehavior="never"
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
					<View className="min-h-0 flex-1 overflow-hidden bg-card">
						<ScrollView horizontal showsHorizontalScrollIndicator>
							<FlatList
								style={{ width: codeWidth }}
								data={lines}
								keyExtractor={(_, index) => `${index}`}
								refreshControl={
									<RefreshControl
										refreshing={refreshing}
										onRefresh={() => void load(true)}
									/>
								}
								contentContainerStyle={{ paddingVertical: 8 }}
								initialNumToRender={48}
								maxToRenderPerBatch={48}
								updateCellsBatchingPeriod={16}
								windowSize={9}
								removeClippedSubviews={Platform.OS === "android"}
								getItemLayout={(_, index) => ({
									length: 24,
									offset: 24 * index,
									index,
								})}
								renderItem={({ item, index }) => (
									<View
										className="h-6 flex-row items-start"
										style={{ width: codeWidth }}
									>
										<Text
											className="w-12 pr-3 text-right font-mono text-[10px] leading-5 text-muted-foreground"
											style={{ fontVariant: ["tabular-nums"] }}
										>
											{index + 1}
										</Text>
										<Text
											selectable
											numberOfLines={1}
											ellipsizeMode="clip"
											className="pr-5 font-mono text-[12px] leading-5"
											style={{
												width: codeWidth - 48,
												color: syntaxPalette.plain,
											}}
										>
											{item.length === 0
												? " "
												: tokenizeCodeLine(item, syntaxPalette).map((piece) => (
														<Text
															key={piece.key}
															style={{ color: piece.color }}
														>
															{piece.text}
														</Text>
													))}
										</Text>
									</View>
								)}
							/>
						</ScrollView>
					</View>
				) : null}
			</View>
		</View>
	);
}
