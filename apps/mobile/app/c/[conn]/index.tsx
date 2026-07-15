import { router, Stack, useLocalSearchParams } from "expo-router";
import { MessageSquare } from "lucide-react-native";
import { useEffect, useMemo } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";

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
			bundles.flatMap((bundle) =>
				bundle.sessions.map((session) => {
					const chat = bundle.chats.find((item) => item.id === session.chatId);
					return { project: bundle.project, session, chat };
				}),
			),
		[bundles],
	);
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
				{errorByConnection[connKey] &&
				(connectionSnapshot === undefined ||
					connectionSnapshot.status === "error" ||
					connectionSnapshot.status === "blockedAuth") ? (
					<Text selectable className="px-4 font-sans text-[13px] text-danger">
						{connectionErrorMessage(errorByConnection[connKey])}
					</Text>
				) : null}
				{(connectionSnapshot?.status === "blockedAuth" ||
					connectionSnapshot?.status === "error") &&
				connectionSnapshot.error ? (
					<Text selectable className="px-4 font-sans text-[13px] text-danger">
						{connectionErrorMessage(connectionSnapshot.error)}
					</Text>
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
						{rows.map(({ session, chat }) => (
							<SessionRow
								key={session.id}
								session={session}
								chat={chat}
								status={
									statusBySession[connectionSessionKey(connKey, session.id)]
								}
								unread={chat !== undefined && isUnread(chat)}
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
