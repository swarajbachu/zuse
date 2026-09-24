import { useAtomValue } from "@effect/atom-react";
import { Cancel01Icon, PlusSignIcon } from "@zuse/icons/solid-rounded";
import { router, Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import { Search } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	AppState,
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
import { ProjectDragRow } from "~/components/home/project-drag-row";
import { useProjectOrder } from "~/components/home/use-project-order";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/empty-state";
import { GlassSurface } from "~/components/ui/glass-surface";
import { HugeIcon } from "~/components/ui/huge-icon";
import { connectionErrorMessage } from "~/lib/connection-error-message";
import { optionsForConnection } from "~/lib/connection-params";
import {
	availableConnections,
	eligibleConnections,
} from "~/lib/connection-records";
import { selectionTap, successTap } from "~/lib/haptics";
import { buildHomeFeed, type HomeFeedItem } from "~/lib/home-feed";
import {
	buildInboxGroups,
	DEFAULT_INBOX_GROUP_DISPLAY,
	type InboxDisplayAction,
	type InboxGroupDisplayState,
	nextInboxGroupDisplay,
} from "~/lib/inbox";
import { startLoadingDeadline } from "~/lib/loading-deadline";
import { moveProject, orderProjects } from "~/lib/project-order";
import {
	authAccountAtom,
	authBusyAtom,
	authErrorAtom,
	authHydratedAtom,
	hydrateAuth,
	signIn,
} from "~/store/auth";
import { cloudCatalogAtom, refreshCloudCatalog } from "~/store/cloud-catalog";
import {
	retryConnection,
	snapshotsByConnectionAtom,
	watchConnection,
} from "~/store/connection-runtime";
import {
	allConnectionsAtom as connectionsAtom,
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
	completeOnboarding,
	hydrateOnboarding,
	onboardingCompleteAtom,
	onboardingHydratedAtom,
} from "~/store/onboarding";
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
	hydrateSessions,
	loadingByConnectionAtom,
	refreshSessionsAfterConnect,
	statusBySessionAtom,
} from "~/store/sessions";
import { colors } from "~/theme";

const LOGO = require("../assets/icon.png");

const HEADER_ACTION_STYLE = {
	width: 40,
	height: 40,
	alignItems: "center",
	justifyContent: "center",
	borderRadius: 20,
} as const;

type ChatFeedItem = HomeFeedItem & { type: "chat" };

export default function HomeScreen() {
	const { width } = useWindowDimensions();
	const [search, setSearch] = useState("");
	const [displayStates, setDisplayStates] = useState<
		ReadonlyMap<string, InboxGroupDisplayState>
	>(() => new Map());
	const connectingEnvironmentIds = useRef(new Set<string>());
	const account = useAtomValue(authAccountAtom);
	const cloudCatalog = useAtomValue(cloudCatalogAtom);
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
	const projectOrder = useProjectOrder();
	const projectViews = useRef(new Map<string, View>());
	const projectPositions = useRef(new Map<string, number>());
	const [dragging, setDragging] = useState(false);
	const onboardingHydrated = useAtomValue(onboardingHydratedAtom);
	const onboardingComplete = useAtomValue(onboardingCompleteAtom);
	const shouldLaunchOnboarding =
		onboardingHydrated &&
		authHydrated &&
		connectionsHydrated &&
		!onboardingComplete &&
		account === null &&
		connections.length === 0;
	const reachableConnections = useMemo(
		() => eligibleConnections(connections, account !== null),
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
		if (!onboardingHydrated) void hydrateOnboarding();
	}, [onboardingHydrated]);

	useEffect(() => {
		if (busy || !onboardingHydrated || !authHydrated || !connectionsHydrated)
			return;
		if (onboardingComplete) return;
		if (account !== null || connections.length > 0) {
			void completeOnboarding();
			return;
		}
		router.replace("/onboarding");
	}, [
		account,
		authHydrated,
		busy,
		connections.length,
		connectionsHydrated,
		onboardingComplete,
		onboardingHydrated,
	]);

	useEffect(() => {
		if (account === null) return;
		void refreshEnvironments();
		const subscription = AppState.addEventListener("change", (state) => {
			if (state === "active") void refreshEnvironments();
		});
		return () => subscription.remove();
	}, [account]);

	useEffect(() => {
		if (account === null) return;
		for (const environment of environments) {
			const alreadyConnected = connections.some(
				(connection) =>
					connection.source === "api" &&
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

	useEffect(() => {
		for (const connection of reachableConnections) {
			const snapshot = connectionSnapshots[connection.key];
			if (snapshot?.status !== "connected") continue;
			const options = optionsForConnection(connection.key, connections);
			if (options === null) continue;
			void refreshSessionsAfterConnect(
				connection.key,
				options,
				snapshot.generation,
			);
		}
	}, [connectionSnapshots, connections, reachableConnections]);

	const searching = search.trim().length > 0;
	const feedConnections = useMemo(
		() =>
			availableConnections(
				reachableConnections,
				account !== null,
				connectionSnapshots,
				new Set(
					Object.keys(bundlesByConnection).filter(
						(key) => (bundlesByConnection[key]?.length ?? 0) > 0,
					),
				),
			),
		[reachableConnections, account, connectionSnapshots, bundlesByConnection],
	);
	const unorderedGroups = useMemo(
		() =>
			buildInboxGroups({
				connections: feedConnections,
				bundlesByConnection,
				statusBySession,
				query: search,
				pinnedChatKeys: new Set(pinnedKeys),
			}),
		[bundlesByConnection, pinnedKeys, feedConnections, search, statusBySession],
	);
	const projectOrderKey = useCallback(
		(group: (typeof unorderedGroups)[number]) =>
			JSON.stringify([
				connections.find((connection) => connection.key === group.connectionKey)
					?.environmentId ?? group.connectionKey,
				group.projectId,
			]),
		[connections],
	);
	const groups = useMemo(
		() => orderProjects(unorderedGroups, projectOrder.order, projectOrderKey),
		[unorderedGroups, projectOrder.order, projectOrderKey],
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
		(account !== null &&
			cloudCatalog.loading &&
			cloudCatalog.chats.length === 0) ||
		reachableConnections.some(
			(connection) => loadingByConnection[connection.key] === true,
		);
	const connectionFailure =
		feedConnections
			.filter((connection) => connection.source !== "cloud")
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
	const recoveringConnection = feedConnections.find((connection) => {
		if (connection.source === "cloud") return false;
		const status = connectionSnapshots[connection.key]?.status;
		return status === "connecting" || status === "reconnecting";
	});
	const [loadTimedOut, setLoadTimedOut] = useState(false);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const waitingForHome = loading || recoveringConnection !== undefined;
	useEffect(() => {
		// A manual retry starts a new deadline; reconnect status changes do not.
		void loadAttempt;
		setLoadTimedOut(false);
		if (!waitingForHome) return;
		return startLoadingDeadline(() => setLoadTimedOut(true));
	}, [waitingForHome, loadAttempt]);
	const homeLoadFailed =
		loadTimedOut ||
		connectionError !== null ||
		(account !== null && environmentsError !== null) ||
		Boolean(cloudCatalog.error);
	const showHomeRecovery = feed.length === 0 && homeLoadFailed;
	const retryHome = async () => {
		const pending: Promise<unknown>[] = [];
		setLoadTimedOut(false);
		setLoadAttempt((attempt) => attempt + 1);
		if (account !== null) {
			pending.push(refreshEnvironments(), refreshCloudCatalog());
		}
		for (const connection of reachableConnections) {
			const options = optionsForConnection(connection.key, connections);
			if (options === null) continue;
			retryConnection(connection.key, options);
			pending.push(hydrateSessions(connection.key, options));
		}
		await Promise.allSettled(pending);
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
			} else if (item.row.session !== null) {
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
					<ProjectDragRow
						enabled={!searching && projectOrder.ready}
						register={(view) => {
							if (view) projectViews.current.set(item.group.key, view);
							else projectViews.current.delete(item.group.key);
						}}
						onStart={() => {
							setDragging(true);
							projectPositions.current.clear();
							for (const [key, view] of projectViews.current)
								view.measureInWindow((_x, y, _width, height) => {
									if (height > 0)
										projectPositions.current.set(key, y + height / 2);
								});
						}}
						onFinish={() => setDragging(false)}
						onDrop={(screenY) => {
							const targets = groups.filter((group) =>
								projectPositions.current.has(group.key),
							);
							const target = targets.reduce<
								(typeof groups)[number] | undefined
							>(
								(best, group) =>
									!best ||
									Math.abs(
										(projectPositions.current.get(group.key) ?? 0) - screenY,
									) <
										Math.abs(
											(projectPositions.current.get(best.key) ?? 0) - screenY,
										)
										? group
										: best,
								undefined,
							);
							if (!target) return;
							const keys = groups.map(projectOrderKey);
							const from = keys.indexOf(projectOrderKey(item.group));
							const next = moveProject(
								keys,
								from,
								keys.indexOf(projectOrderKey(target)) - from,
							);
							projectOrder.save([
								...next,
								...projectOrder.order.filter((key) => !keys.includes(key)),
							]);
						}}
					>
						<HomeProjectHeader
							group={item.group}
							collapsed={item.collapsed}
							connections={reachableConnections}
							onToggle={() => updateGroup(item.group.key, "toggle-collapsed")}
						/>
					</ProjectDragRow>
				);
			case "show-more":
				return (
					<View className="flex-row gap-1 px-3 py-1 pl-10">
						{item.hiddenCount > 0 ? (
							<Button
								size="sm"
								variant="ghost"
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
						onArchive={onArchiveRow}
						onTogglePin={onTogglePinRow}
					/>
				);
		}
	};

	if (
		!authHydrated ||
		!connectionsHydrated ||
		!onboardingHydrated ||
		shouldLaunchOnboarding
	) {
		return (
			<View className="flex-1 bg-background px-4 pt-28">
				<HomeSkeleton />
			</View>
		);
	}

	return (
		<>
			<Stack.Screen
				options={{
					title: "Zuse",
					headerLargeTitle: false,
					headerTitle: () => <BrandTitle />,
					headerRight: () => (
						<View className="flex-row items-center gap-2">
							<Pressable
								accessibilityRole="button"
								accessibilityLabel="Pair with desktop"
								hitSlop={4}
								onPress={() => router.push("/connect/scan")}
								style={({ pressed }) => [
									HEADER_ACTION_STYLE,
									pressed && { opacity: 0.72 },
								]}
							>
								<SymbolView
									name="qrcode.viewfinder"
									size={19}
									weight="semibold"
									tintColor={colors.fg}
								/>
							</Pressable>
							<Pressable
								accessibilityRole="button"
								accessibilityLabel="Open settings"
								hitSlop={4}
								onPress={() => router.push("/settings")}
								style={({ pressed }) => [
									HEADER_ACTION_STYLE,
									pressed && { opacity: 0.72 },
								]}
							>
								<SymbolView
									name="gearshape.fill"
									size={20}
									weight="medium"
									tintColor={colors.fg}
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
							editable={!dragging}
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
				scrollEnabled={!dragging}
				className="flex-1 bg-background"
				data={feed}
				keyExtractor={(item) => item.key}
				renderItem={renderItem}
				contentInsetAdjustmentBehavior="automatic"
				contentContainerClassName="px-4 pb-28 pt-2"
				initialNumToRender={12}
				windowSize={7}
				removeClippedSubviews={!dragging}
				keyboardDismissMode="on-drag"
				keyboardShouldPersistTaps="handled"
				refreshControl={
					<RefreshControl
						refreshing={false}
						tintColor={colors.accent}
						onRefresh={retryHome}
					/>
				}
				ListHeaderComponent={
					<>
						{cloudCatalog.error ? (
							<Text
								role="alert"
								className="px-4 py-2 font-sans text-sm text-destructive"
							>
								{cloudCatalog.error}
							</Text>
						) : null}
						{showHomeRecovery ? null : ((account === null
								? null
								: environmentsError) ?? connectionError) ? (
							<View className="mb-3">
								<ConnectionRecoveryBanner
									message={connectionErrorMessage(
										(account === null ? null : environmentsError) ??
											connectionError,
									)}
									onRetry={retryHome}
									onPairAgain={() => router.push("/connect/scan")}
								/>
							</View>
						) : recoveringConnection !== undefined && feed.length > 0 ? (
							<View className="mb-3">
								<ConnectionRecoveryBanner
									message={
										loadTimedOut
											? "Computer unavailable. Check its connection and retry."
											: `Reconnecting to ${recoveringConnection.label}…`
									}
									onRetry={retryHome}
									recovering={!loadTimedOut}
								/>
							</View>
						) : null}
					</>
				}
				ListEmptyComponent={
					showHomeRecovery ? (
						<View className="gap-3 px-5 pt-8">
							<Text
								accessibilityRole="header"
								className="text-center font-sans-medium text-base text-foreground"
							>
								Couldn’t load your chats
							</Text>
							<Text
								selectable
								className="text-center font-sans text-sm leading-5 text-muted-foreground"
							>
								Keep Zuse open on your Mac and check your connection, then try
								again.
							</Text>
							<View className="gap-3">
								<Button onPress={retryHome}>Try again</Button>
								<Button
									variant="secondary"
									onPress={() => router.push("/settings")}
								>
									Connection settings
								</Button>
								<Button
									variant="ghost"
									onPress={() => router.push("/connect/scan")}
								>
									Scan a new QR code
								</Button>
							</View>
						</View>
					) : waitingForHome ? (
						<View className="items-center gap-3 pt-12">
							<HomeSkeleton />
							<Text className="font-sans-medium text-base text-foreground">
								Connecting to your chats
							</Text>
							<Text className="px-8 text-center font-sans text-sm leading-5 text-muted-foreground">
								Keep your computer awake and Zuse running. We’ll show recovery
								options if it doesn’t respond within 30 seconds.
							</Text>
						</View>
					) : (
						<View className="pt-24">
							<EmptyState
								symbol={
									searching
										? "magnifyingglass"
										: "bubble.left.and.bubble.right.fill"
								}
								title={searching ? "No matching chats" : "No chats yet"}
								detail={
									searching
										? "Try a project, chat title, model, status, or computer name."
										: account === null
											? "Sign in to see your cloud chats, or connect a computer."
											: "Start a cloud chat, or connect a computer to see its chats too."
								}
							/>
							{!searching && reachableConnections.length === 0 ? (
								<View className="mx-auto mt-8 w-full max-w-[380px] gap-3 px-4">
									{account === null ? (
										<Button disabled={busy} onPress={() => void signIn()}>
											{busy ? "Signing in…" : "Sign in"}
										</Button>
									) : null}
									<Button
										variant={account === null ? "secondary" : "primary"}
										onPress={() => router.push("/connect/scan")}
									>
										<SymbolView
											name="qrcode.viewfinder"
											size={18}
											tintColor={
												account === null ? colors.fg : colors.primaryForeground
											}
										/>
										Scan QR code
									</Button>
									<Button
										variant="secondary"
										onPress={() => router.push("/connect/nearby")}
									>
										<SymbolView
											name="wifi"
											size={18}
											weight="light"
											tintColor={colors.fg}
										/>
										Find nearby Mac
									</Button>
									<Button
										variant="ghost"
										onPress={() => router.push("/connect/manual")}
									>
										<HugeIcon icon={PlusSignIcon} size={18} color={colors.fg} />
										Add manually
									</Button>
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
