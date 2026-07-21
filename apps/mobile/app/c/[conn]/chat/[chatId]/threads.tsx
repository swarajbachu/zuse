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
	Alert,
	FlatList,
	Pressable,
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
import { connectionSessionKey } from "~/lib/session-key";
import {
	nearestSurvivingThread,
	threadDisplayTitle,
	threadStatusLabel,
} from "~/lib/thread-presentation";
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
	const connections = useConnectionsStore((state) => state.connections);
	const bundles = useSessionsStore(
		(state) => state.bundlesByConnection[connKey] ?? [],
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
	const detail = useMemo(() => {
		for (const bundle of bundles) {
			const chat = bundle.chats.find((item) => item.id === normalizedChatId);
			if (chat !== undefined) return { chat, project: bundle.project, bundle };
		}
		return null;
	}, [bundles, normalizedChatId]);
	const threads = useMemo(
		() =>
			orderedChatSessions(
				detail?.bundle.sessions ?? [],
				detail?.chat.id ?? null,
			),
		[detail],
	);
	const rows = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		return threads
			.map((thread, index) => ({
				thread,
				index,
				title: threadDisplayTitle(thread, detail?.chat ?? null, index),
			}))
			.filter(({ thread, title }) =>
				normalized.length === 0
					? true
					: `${title} ${thread.providerId} ${thread.model}`
							.toLowerCase()
							.includes(normalized),
			);
	}, [detail?.chat, query, threads]);

	useEffect(() => {
		if (options !== null && detail === null) void hydrate(connKey, options);
	}, [connKey, detail, hydrate, options]);

	const navigateToThread = useCallback(
		(thread: Session) => {
			if (options !== null && detail !== null) {
				void setActiveSession(
					connKey,
					options,
					detail.chat.id,
					thread.id,
				).catch(() => {});
			}
			router.back();
			requestAnimationFrame(() => {
				router.replace({
					pathname: "/c/[conn]/session/[sessionId]",
					params: { conn: connKey, sessionId: thread.id },
				});
			});
		},
		[connKey, detail, options, setActiveSession],
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
			if (options === null || detail === null) return;
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
								void archiveChat(connKey, options, detail.chat.id).then(() => {
									router.dismissTo("/");
								});
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
			detail,
			navigateToThread,
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
		<View className="flex-1 bg-background">
			<Stack.Screen
				options={{
					title: "Threads",
					sheetInitialDetentIndex: threads.length >= LARGE_THREAD_COUNT ? 1 : 0,
				}}
			/>
			<Stack.Toolbar placement="left">
				<Stack.Toolbar.Button icon="xmark" onPress={() => router.back()} />
			</Stack.Toolbar>
			<FlatList
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
							className="min-h-14 flex-row items-center gap-3 rounded-3xl border border-border bg-card px-4 active:bg-card-elevated"
							style={{ borderCurve: "continuous" }}
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
							<View className="min-h-11 flex-row items-center gap-2 rounded-2xl border border-border bg-card px-3">
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
				renderItem={({ item: { thread, title } }) => {
					const status =
						statuses[connectionSessionKey(connKey, thread.id)] ?? thread.status;
					const attention =
						(pendingBySession[connectionSessionKey(connKey, thread.id)] ?? [])
							.length > 0;
					const selected = thread.id === currentSessionId;
					return (
						<Pressable
							accessibilityRole="button"
							accessibilityState={{ selected }}
							accessibilityLabel={`${title}, ${threadStatusLabel(status)}`}
							onPress={() => {
								lightTap();
								navigateToThread(thread);
							}}
							className="min-h-[64px] flex-row items-center gap-3 border-b border-border px-2 py-2 active:bg-card-elevated"
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
									>
										{attention ? "Attention" : threadStatusLabel(status)}
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
		</View>
	);
}
