import { orderedChatSessions } from "@zuse/client-runtime/chat-threads";
import type {
	ChatId,
	Session,
	SessionId,
	SessionStatus,
} from "@zuse/contracts";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Check, Ellipsis, Plus, Search, X } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	FlatList,
	Pressable,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";

import { ProviderLogo } from "~/components/provider-logo";
import { StatusDot } from "~/components/ui/status-dot";
import {
	normalizeConnParam,
	optionsForConnection,
} from "~/lib/connection-params";
import { lightTap } from "~/lib/haptics";
import { selectConnectionBundles } from "~/lib/session-bundles";
import { connectionSessionKey } from "~/lib/session-key";
import {
	nearestSurvivingThread,
	threadDisplayTitle,
	threadStatusLabel,
} from "~/lib/thread-presentation";
import { activeThreadSelection, switchToThread } from "~/lib/thread-switching";
import { useConnectionsStore } from "~/store/connections";
import { usePermissionsStore } from "~/store/permissions";
import { useSessionsStore } from "~/store/sessions";
import { colors } from "~/theme";

const LARGE_THREAD_COUNT = 8;

export default function ThreadsScreen() {
	const { conn, chatId, sessionId } = useLocalSearchParams<{
		conn: string;
		chatId: string;
		sessionId?: string;
	}>();
	const connKey = normalizeConnParam(conn);
	const normalizedChatId = normalizeConnParam(chatId) as ChatId;
	const currentSessionId = normalizeConnParam(sessionId ?? "") as SessionId;
	const [query, setQuery] = useState("");
	const [switchingSessionId, setSwitchingSessionId] =
		useState<SessionId | null>(null);
	const connections = useConnectionsStore((state) => state.connections);
	const bundles = useSessionsStore((state) =>
		selectConnectionBundles(state.bundlesByConnection, connKey),
	);
	const statuses = useSessionsStore((state) => state.statusBySession);
	const pendingBySession = usePermissionsStore(
		(state) => state.pendingBySession,
	);
	const hydrate = useSessionsStore((state) => state.hydrate);
	const setActiveSession = useSessionsStore((state) => state.setActiveSession);
	const renameSession = useSessionsStore((state) => state.renameSession);
	const archiveSession = useSessionsStore((state) => state.archiveSession);
	const archiveChat = useSessionsStore((state) => state.archiveChat);
	const options = useMemo(
		() => optionsForConnection(connKey, connections),
		[connKey, connections],
	);
	const chat = useMemo(
		() =>
			bundles
				.flatMap((bundle) => bundle.chats)
				.find((item) => item.id === normalizedChatId) ?? null,
		[bundles, normalizedChatId],
	);
	const allConnectionSessions = useMemo(
		() => bundles.flatMap((bundle) => bundle.sessions),
		[bundles],
	);
	const threads = useMemo(
		() => orderedChatSessions(allConnectionSessions, normalizedChatId),
		[allConnectionSessions, normalizedChatId],
	);
	const activeSessionId = activeThreadSelection(
		chat?.activeSessionId,
		currentSessionId,
	);
	const switchingThread =
		switchingSessionId === null
			? null
			: (threads.find((thread) => thread.id === switchingSessionId) ?? null);
	const rows = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		return threads
			.map((thread, index) => ({
				thread,
				index,
				title: threadDisplayTitle(thread, chat, index),
			}))
			.filter(({ thread, title }) =>
				normalized.length === 0
					? true
					: `${title} ${thread.providerId} ${thread.model}`
							.toLowerCase()
							.includes(normalized),
			);
	}, [chat, query, threads]);

	useEffect(() => {
		if (options !== null && chat === null && threads.length === 0) {
			void hydrate(connKey, options);
		}
	}, [chat, connKey, hydrate, options, threads.length]);

	const navigateToThread = useCallback(
		(thread: Session) => {
			if (switchingSessionId !== null) return;
			if (thread.id === activeSessionId) {
				router.back();
				return;
			}
			if (options === null) {
				Alert.alert(
					"Can’t switch threads",
					"The Mac connection is unavailable.",
				);
				return;
			}
			try {
				switchToThread(
					thread.id,
					setSwitchingSessionId,
					(sessionId) =>
						setActiveSession(connKey, options, normalizedChatId, sessionId),
					(sessionId) =>
						router.dismissTo({
							pathname: "/c/[conn]/session/[sessionId]",
							params: { conn: connKey, sessionId, openAtLatest: "1" },
						}),
				);
			} catch {
				setSwitchingSessionId(null);
				Alert.alert(
					"Couldn’t switch threads",
					"The selected thread could not be activated. Try again.",
				);
			}
		},
		[
			activeSessionId,
			connKey,
			normalizedChatId,
			options,
			setActiveSession,
			switchingSessionId,
		],
	);

	const openNewThread = useCallback(() => {
		router.back();
		requestAnimationFrame(() => {
			router.push({
				pathname: "/new-chat",
				params: { conn: connKey, chatId: normalizedChatId },
			});
		});
	}, [connKey, normalizedChatId]);

	const archiveThread = useCallback(
		(thread: Session) => {
			if (options === null) return;
			if (threads.length === 1) {
				Alert.alert(
					"Archive chat?",
					"This is the final thread. Archive the entire chat instead?",
					[
						{ text: "Cancel", style: "cancel" },
						{
							text: "Archive chat",
							style: "destructive",
							onPress: () => {
								void archiveChat(connKey, options, normalizedChatId).then(
									() => {
										router.dismissTo("/");
									},
								);
							},
						},
					],
				);
				return;
			}
			Alert.alert("Archive thread?", "Its transcript will leave this chat.", [
				{ text: "Cancel", style: "cancel" },
				{
					text: "Archive",
					style: "destructive",
					onPress: () => {
						const next = nearestSurvivingThread(threads, thread.id);
						void archiveSession(connKey, options, thread.id).then(() => {
							if (thread.id === currentSessionId && next !== null) {
								navigateToThread(next);
							}
						});
					},
				},
			]);
		},
		[
			archiveChat,
			archiveSession,
			connKey,
			currentSessionId,
			navigateToThread,
			normalizedChatId,
			options,
			threads,
		],
	);

	const openActions = useCallback(
		(thread: Session, title: string) => {
			if (options === null) return;
			Alert.alert(title, undefined, [
				{
					text: "Rename",
					onPress: () =>
						Alert.prompt(
							"Rename thread",
							undefined,
							(value) => {
								if (value?.trim())
									void renameSession(connKey, options, thread.id, value);
							},
							"plain-text",
							title,
						),
				},
				{
					text: threads.length === 1 ? "Archive chat" : "Archive thread",
					style: "destructive",
					onPress: () => archiveThread(thread),
				},
				{ text: "Cancel", style: "cancel" },
			]);
		},
		[archiveThread, connKey, options, renameSession, threads.length],
	);

	return (
		<View style={{ width: "100%", height: "100%" }}>
			<FlatList
				style={{ width: "100%", height: "100%" }}
				data={rows}
				keyExtractor={({ thread }) => thread.id}
				contentInsetAdjustmentBehavior="automatic"
				contentContainerClassName="px-4 pb-8"
				keyboardDismissMode="on-drag"
				keyboardShouldPersistTaps="handled"
				ListHeaderComponent={
					<View className="gap-3 pb-3 pt-2">
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Create new thread"
							onPress={openNewThread}
							className="min-h-14 flex-row items-center gap-3 rounded-2xl bg-card px-4 active:bg-card-elevated"
							style={{
								borderCurve: "continuous",
								borderWidth: StyleSheet.hairlineWidth,
								borderColor: colors.border,
							}}
						>
							<View className="h-8 w-8 items-center justify-center rounded-xl bg-primary">
								<Plus size={18} color={colors.primaryForeground} />
							</View>
							<View className="flex-1">
								<Text className="font-sans-medium text-[16px] text-foreground">
									New thread
								</Text>
								<Text className="font-sans text-[12px] text-muted-foreground">
									Uses this chat&apos;s workspace
								</Text>
							</View>
						</Pressable>
						{threads.length >= LARGE_THREAD_COUNT ? (
							<View
								className="min-h-11 flex-row items-center gap-2 rounded-2xl bg-card px-3"
								style={{
									borderCurve: "continuous",
									borderWidth: StyleSheet.hairlineWidth,
									borderColor: colors.border,
								}}
							>
								<Search size={17} color={colors.secondaryFg} />
								<TextInput
									accessibilityLabel="Search threads"
									className="min-h-11 flex-1 font-sans text-[16px] text-foreground"
									placeholder="Search threads"
									placeholderTextColor={colors.tertiaryFg}
									value={query}
									onChangeText={setQuery}
								/>
								{query.length > 0 ? (
									<Pressable
										accessibilityRole="button"
										accessibilityLabel="Clear thread search"
										hitSlop={10}
										onPress={() => setQuery("")}
									>
										<X size={16} color={colors.secondaryFg} />
									</Pressable>
								) : null}
							</View>
						) : null}
					</View>
				}
				renderItem={({ item: { thread, title }, index }) => {
					const status =
						statuses[connectionSessionKey(connKey, thread.id)] ?? thread.status;
					const attention =
						(pendingBySession[connectionSessionKey(connKey, thread.id)] ?? [])
							.length > 0;
					const selected = thread.id === activeSessionId;
					return (
						<Pressable
							accessibilityRole="button"
							accessibilityState={{ selected }}
							accessibilityLabel={`${title}, ${
								selected ? "active thread" : threadStatusLabel(status)
							}`}
							onPress={() => {
								lightTap();
								void navigateToThread(thread);
							}}
							className="min-h-[64px] flex-row items-center gap-3 px-3 py-2"
							style={({ pressed }) => ({
								backgroundColor:
									pressed || selected ? colors.cardElevated : colors.card,
								borderCurve: "continuous",
								borderColor: colors.border,
								borderLeftWidth: StyleSheet.hairlineWidth,
								borderRightWidth: StyleSheet.hairlineWidth,
								borderTopWidth: index === 0 ? StyleSheet.hairlineWidth : 0,
								borderBottomWidth: StyleSheet.hairlineWidth,
								borderTopLeftRadius: index === 0 ? 16 : 0,
								borderTopRightRadius: index === 0 ? 16 : 0,
								borderBottomLeftRadius: index === rows.length - 1 ? 16 : 0,
								borderBottomRightRadius: index === rows.length - 1 ? 16 : 0,
							})}
						>
							<View className="h-9 w-9 items-center justify-center rounded-xl bg-muted">
								<ProviderLogo providerId={thread.providerId} size={18} />
							</View>
							<View className="min-w-0 flex-1">
								<Text
									className="font-sans-medium text-[15px] text-foreground"
									numberOfLines={1}
								>
									{title}
								</Text>
								<Text
									className="mt-0.5 font-sans text-[12px] text-muted-foreground"
									numberOfLines={1}
								>
									{thread.providerId} · {thread.model}
								</Text>
							</View>
							<View className="w-20 items-end">
								<View className="flex-row items-center gap-1.5">
									{selected ? (
										<Check size={15} color={colors.accent} />
									) : (
										<StatusDot status={status as SessionStatus} />
									)}
									<Text
										className={
											attention
												? "font-sans text-[11px] text-warning"
												: "font-sans text-[11px] text-muted-foreground"
										}
										style={selected ? { color: colors.accent } : undefined}
									>
										{selected
											? "Active"
											: attention
												? "Attention"
												: threadStatusLabel(status)}
									</Text>
								</View>
							</View>
							<Pressable
								accessibilityRole="button"
								accessibilityLabel={`Actions for ${title}`}
								className="h-11 w-11 items-center justify-center"
								onPress={() => openActions(thread, title)}
							>
								<Ellipsis size={19} color={colors.secondaryFg} />
							</Pressable>
						</Pressable>
					);
				}}
				ListEmptyComponent={
					<Text className="py-10 text-center font-sans text-[14px] text-muted-foreground">
						No matching threads
					</Text>
				}
			/>
			{switchingThread !== null ? (
				<View
					accessibilityRole="progressbar"
					accessibilityLabel="Loading selected thread"
					accessibilityViewIsModal
					style={{
						position: "absolute",
						inset: 0,
						alignItems: "center",
						justifyContent: "center",
						gap: 10,
						backgroundColor: colors.card,
					}}
				>
					<ActivityIndicator size="large" color={colors.accent} />
					<Text className="font-sans-medium text-[16px] text-foreground">
						Opening thread…
					</Text>
					<Text className="font-sans text-[13px] text-muted-foreground">
						Loading its conversation
					</Text>
				</View>
			) : null}
			<Stack.Toolbar placement="left">
				<Stack.Toolbar.Button
					icon="xmark"
					disabled={switchingSessionId !== null}
					onPress={() => router.back()}
				/>
			</Stack.Toolbar>
		</View>
	);
}
