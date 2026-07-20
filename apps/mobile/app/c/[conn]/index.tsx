import {
	orderedChatSessions,
	resolveActiveChatSession,
} from "@zuse/client-runtime/chat-threads";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { MessageSquare } from "lucide-react-native";
import { useEffect, useMemo } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";

import { ConnectionRecoveryBanner } from "~/components/connection-recovery-banner";
import { SessionRow } from "~/components/session-row";
import { EmptyState } from "~/components/ui/empty-state";
import { ListSection } from "~/components/ui/list";
import { connectionErrorMessage } from "~/lib/connection-error-message";
import {
	normalizeConnParam,
	optionsForConnection,
} from "~/lib/connection-params";
import { visibleConnectionLabel } from "~/lib/display-names";
import { connectionSessionKey } from "~/lib/session-key";
import { useConnectionRuntimeStore } from "~/store/connection-runtime";
import { useConnectionsStore } from "~/store/connections";
import { isUnread, useSessionsStore } from "~/store/sessions";
import { colors } from "~/theme";

export default function SessionsScreen() {
	const { conn } = useLocalSearchParams<{ conn: string }>();
	const connKey = normalizeConnParam(conn);
	const {
		connections,
		hydrated,
		hydrate: hydrateConnections,
	} = useConnectionsStore();
	const {
		bundlesByConnection,
		statusBySession,
		errorByConnection,
		loadingByConnection,
		hydrate,
	} = useSessionsStore();
	const options = useMemo(
		() => optionsForConnection(connKey, connections),
		[connKey, connections],
	);
	const connectionLabel = useMemo(
		() =>
			visibleConnectionLabel(
				connections.find((connection) => connection.key === connKey)?.label,
			),
		[connKey, connections],
	);
	const watchConnection = useConnectionRuntimeStore((state) => state.watch);
	const retryConnection = useConnectionRuntimeStore((state) => state.retry);
	const connectionSnapshot = useConnectionRuntimeStore(
		(state) => state.snapshotsByConnection[connKey],
	);
	const bundles = useMemo(
		() => bundlesByConnection[connKey] ?? [],
		[bundlesByConnection, connKey],
	);
	useEffect(() => {
		if (!hydrated) void hydrateConnections();
	}, [hydrateConnections, hydrated]);

	useEffect(() => {
		if (connKey.length === 0 || options === null) return;
		return watchConnection(connKey, options);
	}, [connKey, options, watchConnection]);

	useEffect(() => {
		void connectionSnapshot?.generation;
		if (connKey.length > 0 && options !== null) void hydrate(connKey, options);
	}, [connKey, connectionSnapshot?.generation, hydrate, options]);

	const rows = useMemo(
		() =>
			bundles.flatMap((bundle) => {
				const activeChats = bundle.chats.filter(
					(chat) => chat.archivedAt === null,
				);
				const knownChatIds = new Set(activeChats.map((chat) => chat.id));
				const chatRows = activeChats.flatMap((chat) => {
					const threads = orderedChatSessions(bundle.sessions, chat.id);
					const session = resolveActiveChatSession(chat, threads);
					if (session === null) return [];
					const runningCount = threads.filter((thread) => {
						const status =
							statusBySession[connectionSessionKey(connKey, thread.id)];
						return (status ?? thread.status) === "running";
					}).length;
					return [
						{
							project: bundle.project,
							session,
							chat,
							threadCount: threads.length,
							runningCount,
						},
					];
				});
				const orphanRows = bundle.sessions
					.filter(
						(session) =>
							session.archivedAt === null && !knownChatIds.has(session.chatId),
					)
					.map((session) => ({
						project: bundle.project,
						session,
						chat: undefined,
						threadCount: 1,
						runningCount:
							(statusBySession[connectionSessionKey(connKey, session.id)] ??
								session.status) === "running"
								? 1
								: 0,
					}));
				return [...chatRows, ...orphanRows];
			}),
		[bundles, connKey, statusBySession],
	);
	const connectionFailure =
		(connectionSnapshot?.status === "blockedAuth" ||
			connectionSnapshot?.status === "error") &&
		connectionSnapshot.error
			? connectionSnapshot.error
			: connectionSnapshot === undefined ||
					connectionSnapshot.status === "error" ||
					connectionSnapshot.status === "blockedAuth"
				? errorByConnection[connKey]
				: null;
	return (
		<>
			<Stack.Screen
				options={{
					title: "Sessions",
				}}
			/>
			<ScrollView
				className="flex-1 bg-background"
				contentInsetAdjustmentBehavior="automatic"
				contentContainerClassName="gap-6 p-4 pb-16"
				refreshControl={
					<RefreshControl
						refreshing={loadingByConnection[connKey] === true}
						onRefresh={() => {
							if (options !== null) void hydrate(connKey, options);
						}}
						tintColor={colors.accent}
					/>
				}
			>
				{hydrated && options === null ? (
					<Text selectable className="px-4 font-sans text-[13px] text-danger">
						This saved connection could not be found on this phone. Go back and
						connect the computer again.
					</Text>
				) : null}
				{connectionFailure !== null &&
				connectionFailure !== undefined &&
				options !== null ? (
					<ConnectionRecoveryBanner
						message={connectionErrorMessage(connectionFailure)}
						onRetry={() => retryConnection(connKey, options)}
						onPairAgain={() => router.push("/connect/scan")}
					/>
				) : null}

				{rows.length === 0 ? (
					<View className="pt-24">
						<EmptyState
							icon={MessageSquare}
							title="No sessions"
							detail="Cached sessions appear here first, then refresh over WebSocket."
						/>
					</View>
				) : (
					<ListSection header={connectionLabel}>
						{rows.map(({ session, chat, threadCount, runningCount }) => (
							<SessionRow
								key={session.id}
								session={session}
								chat={chat}
								status={
									statusBySession[connectionSessionKey(connKey, session.id)]
								}
								unread={chat !== undefined && isUnread(chat)}
								threadCount={threadCount}
								runningCount={runningCount}
								onPress={() =>
									router.push(
										`/c/${encodeURIComponent(connKey)}/session/${encodeURIComponent(session.id)}`,
									)
								}
							/>
						))}
					</ListSection>
				)}
			</ScrollView>
		</>
	);
}
