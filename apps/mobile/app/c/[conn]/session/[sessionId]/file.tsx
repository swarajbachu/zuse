import { useAtomValue } from "@effect/atom-react";
import {
	classifyMedia,
	mediaMimeType,
	sanitizeSvg,
} from "@zuse/client-runtime/media";
import type { FolderId, FsFileContent, SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import { Image } from "expo-image";
import { Stack, useLocalSearchParams } from "expo-router";
import { Eye, FileText, Share2 } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	FlatList,
	Platform,
	Pressable,
	RefreshControl,
	ScrollView,
	Share,
	Text,
	useWindowDimensions,
	View,
} from "react-native";
import { useUniwind } from "uniwind";

import {
	normalizeConnParam,
	optionsForConnection,
} from "~/lib/connection-params";
import { cacheMediaBytes } from "~/lib/media-cache";
import {
	DARK_SYNTAX,
	LIGHT_SYNTAX,
	tokenizeCodeLine,
} from "~/lib/syntax-highlighting";
import { basename } from "~/lib/workspace-path";
import { readWorkspaceFile } from "~/rpc/actions";
import { connectionsAtom } from "~/store/connections";
import { connectionBundlesAtom, selectSessionChat } from "~/store/sessions";
import { colors } from "~/theme";
import { presentQuickLook } from "../../../../../modules/mobile-platform";

export default function WorkspaceFileScreen() {
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
	const connections = useAtomValue(connectionsAtom);
	const bundles = useAtomValue(connectionBundlesAtom(connKey));
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
	const [binaryPreviewUri, setBinaryPreviewUri] = useState<string | null>(null);

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

	useEffect(() => {
		if (file?.kind !== "binary" || folderId === undefined) {
			setBinaryPreviewUri(null);
			return;
		}
		const mimeType = mediaMimeType(path);
		let active = true;
		void (async () => {
			const bytes =
				classifyMedia(path, mimeType) === "image" &&
				mimeType === "image/svg+xml"
					? new TextEncoder().encode(
							sanitizeSvg(new TextDecoder().decode(file.bytes)),
						)
					: file.bytes;
			const uri = await cacheMediaBytes({
				connectionKey: connKey,
				key: `workspace-${folderId}-${worktreeId ?? "root"}-${path}`,
				bytes,
				mimeType,
				originalName: basename(path),
			});
			if (active) setBinaryPreviewUri(uri);
		})();
		return () => {
			active = false;
		};
	}, [connKey, file, folderId, path, worktreeId]);

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
					headerBackVisible: true,
					headerLargeTitle: false,
					headerTitleStyle: { color: colors.fg },
				}}
			/>
			<Stack.Screen.Title>{basename(path)}</Stack.Screen.Title>
			<View className="flex-1">
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
				{file?.kind === "binary" &&
				binaryPreviewUri !== null &&
				classifyMedia(path, mediaMimeType(path)) === "image" ? (
					<ScrollView
						contentInsetAdjustmentBehavior="automatic"
						contentContainerStyle={{ alignItems: "center", padding: 16 }}
						maximumZoomScale={5}
						minimumZoomScale={1}
						bouncesZoom
					>
						<Image
							source={{ uri: binaryPreviewUri }}
							style={{ width: Math.max(width - 32, 1), height: width }}
							contentFit="contain"
							accessibilityLabel={basename(path)}
						/>
					</ScrollView>
				) : null}
				{file?.kind === "binary" &&
				(binaryPreviewUri === null ||
					classifyMedia(path, mediaMimeType(path)) !== "image") ? (
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
							Use the native document preview, or share this file with another
							app.
						</Text>
						{binaryPreviewUri === null ? null : (
							<View className="mt-5 flex-row gap-3">
								<Pressable
									accessibilityRole="button"
									accessibilityLabel={`Preview ${basename(path)}`}
									className="min-h-11 flex-row items-center gap-2 rounded-xl bg-primary px-4 active:opacity-60"
									onPress={() => {
										if (!presentQuickLook(binaryPreviewUri)) {
											void Share.share({ url: binaryPreviewUri });
										}
									}}
								>
									<Eye size={17} color={colors.primaryForeground} />
									<Text className="font-sans-medium text-primary-foreground">
										Preview
									</Text>
								</Pressable>
								<Pressable
									accessibilityRole="button"
									accessibilityLabel={`Share ${basename(path)}`}
									className="min-h-11 flex-row items-center gap-2 rounded-xl border border-border bg-card px-4 active:opacity-60"
									onPress={() => void Share.share({ url: binaryPreviewUri })}
								>
									<Share2 size={17} color={colors.fg} />
									<Text className="font-sans-medium text-foreground">
										Share
									</Text>
								</Pressable>
							</View>
						)}
					</ScrollView>
				) : null}
				{file?.kind === "text" ? (
					<View className="min-h-0 flex-1 overflow-hidden bg-card">
						<ScrollView horizontal showsHorizontalScrollIndicator>
							<FlatList
								contentInsetAdjustmentBehavior="automatic"
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
