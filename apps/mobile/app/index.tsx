import {
	Cancel01Icon,
	PlusSignIcon,
	QrCodeIcon,
	Settings01Icon,
	Wifi01Icon,
} from "@hugeicons-pro/core-solid-rounded";
import { useAtomValue } from "@effect/atom-react";
import { router, Stack } from "expo-router";
import { MessageSquare, Search } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	FlatList,
	Image,
	Pressable,
	RefreshControl,
	Text,
	TextInput,
	useWindowDimensions,
	View,
} from "react-native";

import { ConnectionRecoveryBanner } from "~/components/connection-recovery-banner";
import { HomeChatRow } from "~/components/home/home-chat-row";
import { HomeProjectHeader } from "~/components/home/home-project-header";
import { HomeSectionHeader } from "~/components/home/home-section-header";
import { HomeSkeleton } from "~/components/home/home-skeleton";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/empty-state";
import { GlassSurface } from "~/components/ui/glass-surface";
import { HugeIcon } from "~/components/ui/huge-icon";
import { connectionErrorMessage } from "~/lib/connection-error-message";
import { optionsForConnection } from "~/lib/connection-params";
import { availableConnections } from "~/lib/connection-records";
import { buildHomeFeed, type HomeFeedItem } from "~/lib/home-feed";
import { selectionTap, successTap } from "~/lib/haptics";
import {
	buildInboxGroups,
	DEFAULT_INBOX_GROUP_DISPLAY,
	type InboxDisplayAction,
	type InboxGroupDisplayState,
	nextInboxGroupDisplay,
} from "~/lib/inbox";
import {
	authAccountAtom,
	authBusyAtom,
	authErrorAtom,
	authHydratedAtom,
	hydrateAuth,
	signIn,
} from "~/store/auth";
import {
	retryConnection,
	snapshotsByConnectionAtom,
	watchConnection,
} from "~/store/connection-runtime";
import {
	connectionsAtom,
	connectionsHydratedAtom,
	hydrateConnections,
	refreshConnectionLabel,
} from "~/store/connections";
import {
	connectToEnvironment,
	environmentsAtom,
	environmentsErrorAtom,
	environmentsLoadingAtom,
	refreshEnvironments,
} from "~/store/environments";
import {
	hydratePinnedChats,
	pinnedChatKey,
	pinnedChatKeysAtom,
	pinnedChatsHydratedAtom,
	togglePinnedChat,
} from "~/store/pinned-chats";
import {
	archiveChat,
	archiveSession,
	bundlesByConnectionAtom,
	errorByConnectionAtom,
	loadingByConnectionAtom,
	hydrateSessions,
	statusBySessionAtom,
} from "~/store/sessions";
import { colors } from "~/theme";

const LOGO = require("../assets/icon.png");

type ChatFeedItem = HomeFeedItem & { type: "chat" };

export default function HomeScreen() {
	const { width } = useWindowDimensions();
	const [search, setSearch] = useState("");
	const [displayStates, setDisplayStates] = useState<
		ReadonlyMap<string, InboxGroupDisplayState>
	>(() => new Map());
	const connectingEnvironmentIds = useRef(new Set<string>());
	const account = useAtomValue(authAccountAtom);
	const authHydrated = useAtomValue(authHydratedAtom);
	const busy = useAtomValue(authBusyAtom);
	const authError = useAtomValue(authErrorAtom);
	const connections = useAtomValue(connectionsAtom);
	const connectionsHydrated = useAtomValue(connectionsHydratedAtom);
	const environments = useAtomValue(environmentsAtom);
	const environmentsLoading = useAtomValue(environmentsLoadingAtom);
	const environmentsError = useAtomValue(environmentsErrorAtom);
	const connectionSnapshots = useAtomValue(snapshotsByConnectionAtom);
	const bundlesByConnection = useAtomValue(bundlesByConnectionAtom);
	const statusBySession = useAtomValue(statusBySessionAtom);
	const loadingByConnection = useAtomValue(loadingByConnectionAtom);
	const errorByConnection = useAtomValue(errorByConnectionAtom);
	const pinnedHydrated = useAtomValue(pinnedChatsHydratedAtom);
	const pinnedKeys = useAtomValue(pinnedChatKeysAtom);
	const reachableConnections = useMemo(
		() => availableConnections(connections, account !== null),
		[account, connections],
	);

	useEffect(() => {
		if (!authHydrated) void hydrateAuth();
	}, [authHydrated]);

	useEffect(() => {
		if (!connectionsHydrated) void hydrateConnections();
	}, [connectionsHydrated]);

	useEffect(() => {
		if (!pinnedHydrated) void hydratePinnedChats();
	}, [pinnedHydrated]);

	useEffect(() => {
		if (account !== null) void refreshEnvironments();
	}, [account]);

	useEffect(() => {
		if (account === null) return;
		for (const environment of environments) {
			const alreadyConnected = connections.some(
				(connection) =>
					connection.source === "relay" &&
					connection.environmentId === environment.environmentId,
			);
			if (
				environment.presence !== "online" ||
				alreadyConnected ||
				connectingEnvironmentIds.current.has(environment.environmentId)
			) {
				continue;
			}
			connectingEnvironmentIds.current.add(environment.environmentId);
			void connectToEnvironment(environment.environmentId).finally(() => {
				connectingEnvironmentIds.current.delete(environment.environmentId);
			});
		}
	}, [account, connections, environments]);

	useEffect(() => {
		const unwatch = reachableConnections.flatMap((connection) => {
			const options = optionsForConnection(connection.key, connections);
			return options === null ? [] : [watchConnection(connection.key, options)];
		});
		return () => {
			for (const stop of unwatch) stop();
		};
	}, [connections, reachableConnections]);

	useEffect(() => {
		for (const connection of reachableConnections) {
			const options = optionsForConnection(connection.key, connections);
			if (options === null) continue;
			void hydrateSessions(connection.key, options);
			void refreshConnectionLabel(connection.key, options);
		}
	}, [connections, reachableConnections]);

	const searching = search.trim().length > 0;
	const groups = useMemo(
		() =>
			buildInboxGroups({
				connections: reachableConnections,
				bundlesByConnection,
				statusBySession,
				query: search,
				pinnedChatKeys: new Set(pinnedKeys),
			}),
		[
			bundlesByConnection,
			pinnedKeys,
			reachableConnections,
			search,
			statusBySession,
		],
	);
	const feed = useMemo(
		() => buildHomeFeed({ groups, displayStates, searching }),
		[displayStates, groups, searching],
	);
	const loading =
		!authHydrated ||
		!connectionsHydrated ||
		!pinnedHydrated ||
		(account !== null && environmentsLoading) ||
		reachableConnections.some(
			(connection) => loadingByConnection[connection.key] === true,
		);
	const connectionFailure =
		reachableConnections
			.map((connection) => {
				const snapshot = connectionSnapshots[connection.key];
				const failed =
					snapshot?.status === "error" || snapshot?.status === "blockedAuth";
				const error = failed
					? (snapshot.error ?? errorByConnection[connection.key])
					: snapshot === undefined
						? errorByConnection[connection.key]
						: null;
				return error ? ([connection.key, error] as const) : null;
			})
			.find((entry) => entry !== null) ?? null;
	const connectionError = connectionFailure?.[1] ?? null;
	const retryFailedConnection = () => {
		if (connectionFailure === null) {
			if (account !== null) void refreshEnvironments();
			return;
		}
		const [key] = connectionFailure;
		const options = optionsForConnection(key, connections);
		if (options !== null) retryConnection(key, options);
	};

	const updateGroup = useCallback((key: string, action: InboxDisplayAction) => {
		selectionTap();
		setDisplayStates((prev) => {
			const next = new Map(prev);
			next.set(
				key,
				nextInboxGroupDisplay(
					prev.get(key) ?? DEFAULT_INBOX_GROUP_DISPLAY,
					action,
				),
			);
			return next;
		});
	}, []);

	const onArchiveRow = useCallback(
		async (item: ChatFeedItem) => {
			const options = optionsForConnection(item.row.connectionKey, connections);
			if (options === null) return;
			successTap();
			if (item.row.chat !== null) {
				await archiveChat(item.row.connectionKey, options, item.row.chat.id);
			} else {
				await archiveSession(
					item.row.connectionKey,
					options,
					item.row.session.id,
				);
			}
		},
		[connections],
	);

	const onTogglePinRow = useCallback((item: ChatFeedItem) => {
		if (item.row.chat === null) return;
		selectionTap();
		void togglePinnedChat(
			pinnedChatKey(item.row.connectionKey, String(item.row.chat.id)),
		);
	}, []);

	const renderItem = ({ item }: { item: HomeFeedItem }) => {
		switch (item.type) {
			case "section-header":
				return <HomeSectionHeader title={item.title} />;
			case "project-header":
				return (
					<HomeProjectHeader
						group={item.group}
						collapsed={item.collapsed}
						connections={reachableConnections}
						onToggle={() => updateGroup(item.group.key, "toggle-collapsed")}
					/>
				);
			case "show-more":
				return (
					<View className="flex-row gap-2 rounded-b-2xl border-x border-b border-border bg-card px-4 py-3 pl-14">
						{item.hiddenCount > 0 ? (
							<Button
								size="sm"
								variant="secondary"
								onPress={() => updateGroup(item.groupKey, "show-more")}
							>
								{`Show ${item.hiddenCount} more`}
							</Button>
						) : null}
						{item.canShowLess ? (
							<Button
								size="sm"
								variant="ghost"
								onPress={() => updateGroup(item.groupKey, "show-less")}
							>
								Show less
							</Button>
						) : null}
					</View>
				);
			case "chat":
				return (
					<HomeChatRow
						item={item}
						connections={reachableConnections}
						onArchive={onArchiveRow}
						onTogglePin={onTogglePinRow}
					/>
				);
		}
	};

	if (!authHydrated || !connectionsHydrated) {
		return <View className="flex-1 bg-background" />;
	}

	return (
		<>
			<Stack.Screen
				options={{
					title: "Zuse",
					headerLargeTitle: false,
					headerTitle: () => <BrandTitle />,
					headerRight: () => (
						<View className="flex-row items-center gap-5">
							<Pressable
								accessibilityRole="button"
								accessibilityLabel="Pair with desktop"
								hitSlop={12}
								onPress={() => router.push("/connect/scan")}
							>
								<HugeIcon icon={QrCodeIcon} size={21} color={colors.accent} />
							</Pressable>
							<Pressable
								accessibilityRole="button"
								accessibilityLabel="Open settings"
								hitSlop={12}
								onPress={() => router.push("/settings")}
							>
								<HugeIcon
									icon={Settings01Icon}
									size={22}
									color={colors.accent}
								/>
							</Pressable>
						</View>
					),
				}}
			/>
			<Stack.Toolbar placement="bottom">
				<Stack.Toolbar.View separateBackground>
					<GlassSurface
						style={{
							width: Math.min(width - 88, 520),
							minHeight: 44,
							flexDirection: "row",
							alignItems: "center",
							gap: 9,
							paddingHorizontal: 14,
							paddingVertical: 8,
						}}
					>
						<Search size={17} color={colors.secondaryFg} />
						<TextInput
							accessibilityLabel="Search chats"
							autoCapitalize="none"
							autoCorrect={false}
							className="min-h-7 flex-1 font-sans text-[16px] text-foreground"
							placeholder="Search"
							placeholderTextColor={colors.tertiaryFg}
							returnKeyType="search"
							value={search}
							onChangeText={setSearch}
						/>
						{searching ? (
							<Pressable
								accessibilityRole="button"
								accessibilityLabel="Clear search"
								hitSlop={8}
								onPress={() => setSearch("")}
							>
								<HugeIcon
									icon={Cancel01Icon}
									size={15}
									color={colors.secondaryFg}
								/>
							</Pressable>
						) : null}
					</GlassSurface>
				</Stack.Toolbar.View>
				<Stack.Toolbar.Button
					icon="square.and.pencil"
					separateBackground
					onPress={() => router.push("/new-chat")}
				/>
			</Stack.Toolbar>
			<FlatList
				className="flex-1 bg-background"
				data={feed}
				keyExtractor={(item) => item.key}
				renderItem={renderItem}
				contentInsetAdjustmentBehavior="automatic"
				contentContainerClassName="px-4 pb-28 pt-2"
				initialNumToRender={12}
				windowSize={7}
				removeClippedSubviews
				keyboardDismissMode="on-drag"
				keyboardShouldPersistTaps="handled"
				refreshControl={
					<RefreshControl
						refreshing={loading && feed.length > 0}
						tintColor={colors.accent}
						onRefresh={() => {
							if (account !== null) void refreshEnvironments();
							for (const connection of reachableConnections) {
								const options = optionsForConnection(
									connection.key,
									connections,
								);
								if (options !== null)
									void hydrateSessions(connection.key, options);
							}
						}}
					/>
				}
				ListHeaderComponent={
					((account === null ? null : environmentsError) ?? connectionError) ? (
						<View className="mb-3">
							<ConnectionRecoveryBanner
								message={connectionErrorMessage(
									(account === null ? null : environmentsError) ??
										connectionError,
								)}
								onRetry={retryFailedConnection}
								onPairAgain={() => router.push("/connect/scan")}
							/>
						</View>
					) : null
				}
				ListEmptyComponent={
					loading ? (
						<HomeSkeleton />
					) : (
						<View className="pt-24">
							<EmptyState
								icon={searching ? Search : MessageSquare}
								title={searching ? "No matching chats" : "No chats yet"}
								detail={
									searching
										? "Try a project, chat title, model, status, or computer name."
										: "Open the desktop app on a linked computer to start or resume a chat."
								}
							/>
							{!searching && reachableConnections.length === 0 ? (
								<View className="mt-8 gap-3 px-4">
									<Button onPress={() => router.push("/connect/nearby")}>
										<HugeIcon
											icon={Wifi01Icon}
											size={18}
											color={colors.primaryForeground}
										/>
										Find nearby Mac
									</Button>
									<Button
										variant="secondary"
										onPress={() => router.push("/connect/manual")}
									>
										<HugeIcon
											icon={PlusSignIcon}
											size={18}
											color={colors.fg}
										/>
										Add manually
									</Button>
									{account === null ? (
										<Button
											variant="ghost"
											disabled={busy}
											onPress={() => void signIn()}
										>
											{busy ? "Signing in…" : "Sign in for remote access"}
										</Button>
									) : null}
									{account === null && authError ? (
										<Text
											selectable
											className="text-center font-sans text-sm text-danger"
										>
											{authError}
										</Text>
									) : null}
								</View>
							) : null}
						</View>
					)
				}
			/>
		</>
	);
}

function BrandTitle() {
	return (
		<View className="flex-row items-center gap-2">
			<Image source={LOGO} className="h-7 w-7 rounded-lg" resizeMode="cover" />
			<Text className="font-sans-bold text-[18px] text-foreground">Zuse</Text>
		</View>
	);
}
