import { Link, router, Stack } from "expo-router";
import {
	Archive,
	ChevronDown,
	ChevronRight,
	Loader2,
	MessageSquare,
	Pin,
	Plus,
	QrCode,
	Radio,
	Search,
	Settings,
	X,
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ActivityIndicator,
	type ColorValue,
	Image,
	Pressable,
	RefreshControl,
	ScrollView,
	Text,
	TextInput,
	useWindowDimensions,
	View,
} from "react-native";
import Swipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import { ConnectionRecoveryBanner } from "~/components/connection-recovery-banner";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/empty-state";
import { GlassSurface } from "~/components/ui/glass-surface";
import { PresenceDot } from "~/components/ui/presence-dot";
import { cn } from "~/lib/cn";
import { connectionErrorMessage } from "~/lib/connection-error-message";
import { optionsForConnection } from "~/lib/connection-params";
import { availableConnections } from "~/lib/connection-records";
import { githubOwnerAvatarUrl } from "~/lib/display-names";
import { selectionTap, successTap } from "~/lib/haptics";
import {
	buildInboxGroups,
	buildInboxListItems,
	DEFAULT_INBOX_GROUP_DISPLAY,
	type InboxDisplayAction,
	type InboxGroupDisplayState,
	type InboxListItem,
	nextInboxGroupDisplay,
} from "~/lib/inbox";
import { branchStatePresentation } from "~/lib/pr-state-presentation";
import { useAuthStore } from "~/store/auth";
import { useConnectionRuntimeStore } from "~/store/connection-runtime";
import { useConnectionsStore } from "~/store/connections";
import { useEnvironmentsStore } from "~/store/environments";
import { usePinnedChatsStore } from "~/store/pinned-chats";
import { prStateKey, usePrStateStore } from "~/store/pr-state";
import {
	projectOriginKey,
	useProjectOriginStore,
} from "~/store/project-origins";
import { useSessionsStore } from "~/store/sessions";
import { colors } from "~/theme";

const LOGO = require("../assets/icon.png");

export default function HomeScreen() {
	const { width } = useWindowDimensions();
	const [search, setSearch] = useState("");
	const [displayStates, setDisplayStates] = useState<
		ReadonlyMap<string, InboxGroupDisplayState>
	>(() => new Map());
	const connectingEnvironmentIds = useRef(new Set<string>());
	const {
		account,
		hydrated: authHydrated,
		busy,
		error: authError,
		hydrate: hydrateAuth,
		signIn,
	} = useAuthStore();
	const {
		connections,
		hydrated: connectionsHydrated,
		hydrate: hydrateConnections,
		refreshLabel,
	} = useConnectionsStore();
	const {
		environments,
		loading: environmentsLoading,
		error: environmentsError,
		refresh: refreshEnvironments,
		connect,
	} = useEnvironmentsStore();
	const watchConnection = useConnectionRuntimeStore((state) => state.watch);
	const retryConnection = useConnectionRuntimeStore((state) => state.retry);
	const connectionSnapshots = useConnectionRuntimeStore(
		(state) => state.snapshotsByConnection,
	);
	const {
		bundlesByConnection,
		statusBySession,
		loadingByConnection,
		errorByConnection,
		hydrate: hydrateSessions,
		archiveChat,
		archiveSession,
	} = useSessionsStore();
	const pinnedHydrated = usePinnedChatsStore((state) => state.hydrated);
	const pinnedKeys = usePinnedChatsStore((state) => state.keys);
	const hydratePinnedChats = usePinnedChatsStore((state) => state.hydrate);
	const reachableConnections = useMemo(
		() => availableConnections(connections, account !== null),
		[account, connections],
	);

	useEffect(() => {
		if (!authHydrated) void hydrateAuth();
	}, [authHydrated, hydrateAuth]);

	useEffect(() => {
		if (!connectionsHydrated) void hydrateConnections();
	}, [connectionsHydrated, hydrateConnections]);

	useEffect(() => {
		if (!pinnedHydrated) void hydratePinnedChats();
	}, [hydratePinnedChats, pinnedHydrated]);

	useEffect(() => {
		if (account !== null) void refreshEnvironments();
	}, [account, refreshEnvironments]);

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
			void connect(environment.environmentId).finally(() => {
				connectingEnvironmentIds.current.delete(environment.environmentId);
			});
		}
	}, [account, connect, connections, environments]);

	useEffect(() => {
		const unwatch = reachableConnections.flatMap((connection) => {
			const options = optionsForConnection(connection.key, connections);
			return options === null ? [] : [watchConnection(connection.key, options)];
		});
		return () => {
			for (const stop of unwatch) stop();
		};
	}, [connections, reachableConnections, watchConnection]);

	useEffect(() => {
		for (const connection of reachableConnections) {
			const options = optionsForConnection(connection.key, connections);
			if (options === null) continue;
			void hydrateSessions(connection.key, options);
			void refreshLabel(connection.key, options);
		}
	}, [connections, hydrateSessions, reachableConnections, refreshLabel]);

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
	const listItems = useMemo(
		() =>
			buildInboxListItems({
				groups,
				displayStates,
				searching: search.trim().length > 0,
			}),
		[displayStates, groups, search],
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
		async (row: InboxListItem & { type: "chat" }) => {
			const options = optionsForConnection(row.row.connectionKey, connections);
			if (options === null) return;
			successTap();
			if (row.row.chat !== null) {
				await archiveChat(row.row.connectionKey, options, row.row.chat.id);
			} else {
				await archiveSession(
					row.row.connectionKey,
					options,
					row.row.session.id,
				);
			}
		},
		[archiveChat, archiveSession, connections],
	);

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
								<QrCode size={21} color={colors.accent} />
							</Pressable>
							<Pressable
								accessibilityRole="button"
								accessibilityLabel="Open settings"
								hitSlop={12}
								onPress={() => router.push("/settings")}
							>
								<Settings size={22} color={colors.accent} />
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
						{search.trim().length > 0 ? (
							<Pressable
								accessibilityRole="button"
								accessibilityLabel="Clear search"
								hitSlop={8}
								onPress={() => setSearch("")}
							>
								<X size={16} color={colors.secondaryFg} />
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
			<ScrollView
				className="flex-1 bg-background"
				contentInsetAdjustmentBehavior="automatic"
				contentContainerClassName="px-4 pb-28 pt-2"
				refreshControl={
					<RefreshControl
						refreshing={loading}
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
			>
				{((account === null ? null : environmentsError) ?? connectionError) ? (
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
				) : null}

				{listItems.length === 0 ? (
					<View className="pt-24">
						<EmptyState
							icon={search.trim().length > 0 ? Search : MessageSquare}
							title={
								search.trim().length > 0 ? "No matching chats" : "No chats yet"
							}
							detail={
								search.trim().length > 0
									? "Try a project, chat title, model, status, or computer name."
									: loading
										? "Loading projects and chats from your linked computers."
										: "Open the desktop app on a linked computer to start or resume a chat."
							}
						/>
						{loading ? (
							<View className="mt-4 items-center">
								<ActivityIndicator color={colors.accent} />
							</View>
						) : null}
						{search.trim().length === 0 &&
						reachableConnections.length === 0 &&
						!loading ? (
							<View className="mt-8 gap-3 px-4">
								<Button onPress={() => router.push("/connect/nearby")}>
									<Radio size={18} color={colors.primaryForeground} />
									Find nearby Mac
								</Button>
								<Button
									variant="secondary"
									onPress={() => router.push("/connect/manual")}
								>
									<Plus size={18} color={colors.fg} />
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
				) : (
					<View>
						{listItems.map((item) => (
							<InboxItem
								key={item.key}
								item={item}
								connections={reachableConnections}
								updateGroup={updateGroup}
								onArchiveRow={onArchiveRow}
							/>
						))}
					</View>
				)}
			</ScrollView>
		</>
	);
}

function InboxItem({
	item,
	connections,
	updateGroup,
	onArchiveRow,
}: {
	item: InboxListItem;
	connections: ReturnType<typeof useConnectionsStore.getState>["connections"];
	updateGroup: (key: string, action: InboxDisplayAction) => void;
	onArchiveRow: (row: InboxListItem & { type: "chat" }) => Promise<void>;
}) {
	const row = item.type === "chat" ? item.row : null;
	const group = item.type === "header" ? item.group : null;
	const options = useMemo(
		() =>
			row === null
				? null
				: optionsForConnection(row.connectionKey, connections),
		[connections, row],
	);
	const groupOptions = useMemo(
		() =>
			group === null
				? null
				: optionsForConnection(group.connectionKey, connections),
		[connections, group],
	);
	const hydratePrState = usePrStateStore((state) => state.hydrate);
	const hydrateProjectOrigin = useProjectOriginStore((state) => state.hydrate);
	const prKey =
		row?.chat?.worktreeId !== undefined && row.chat.worktreeId !== null
			? prStateKey(row.connectionKey, row.projectId, row.chat.worktreeId)
			: null;
	const prInfo = usePrStateStore((state) =>
		prKey === null ? null : (state.byKey[prKey] ?? null),
	);
	const branchState = branchStatePresentation(prInfo);
	const originKey =
		group === null
			? null
			: projectOriginKey(group.connectionKey, group.projectId);
	const origin = useProjectOriginStore((state) =>
		originKey === null ? null : (state.byKey[originKey] ?? null),
	);

	useEffect(() => {
		if (
			row?.chat?.worktreeId === undefined ||
			row.chat.worktreeId === null ||
			options === null
		) {
			return;
		}
		void hydratePrState(
			row.connectionKey,
			options,
			row.projectId,
			row.chat.worktreeId,
		);
	}, [hydratePrState, options, row]);

	useEffect(() => {
		if (group === null || groupOptions === null) return;
		void hydrateProjectOrigin(
			group.connectionKey,
			groupOptions,
			group.projectId,
		);
	}, [group, groupOptions, hydrateProjectOrigin]);

	if (item.type === "header") {
		const Icon = item.collapsed ? ChevronRight : ChevronDown;
		const avatarUrl =
			origin === null
				? item.group.avatarUrl
				: githubOwnerAvatarUrl(origin.owner);
		return (
			<Pressable
				accessibilityRole="button"
				accessibilityState={{ expanded: !item.collapsed }}
				onPress={() => updateGroup(item.group.key, "toggle-collapsed")}
				className={cn(
					"min-h-[64px] flex-row items-center gap-3 rounded-t-2xl border-x border-t border-border bg-card px-3 py-3 active:opacity-70",
					!item.isFirst && "mt-4",
					item.collapsed && "rounded-b-2xl border-b",
				)}
				style={{ borderCurve: "continuous" }}
			>
				<Icon size={18} color={colors.tertiaryFg} />
				<ProjectLogo title={item.group.title} avatarUrl={avatarUrl} />
				<View className="min-w-0 flex-1">
					<View className="flex-row items-center gap-2">
						<Text
							className="min-w-0 flex-1 font-sans-bold text-[17px] text-foreground"
							numberOfLines={1}
						>
							{item.group.title}
						</Text>
						{item.group.activeCount > 0 ? (
							<View className="flex-row items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5">
								<Loader2 size={11} color={colors.warning} />
								<Text className="font-sans-medium text-[11px] text-warning">
									{item.group.activeCount}
								</Text>
							</View>
						) : null}
						<Text className="font-sans text-[13px] text-muted-foreground">
							{item.group.rows.length}
						</Text>
					</View>
					<Text
						className="font-sans text-[12px] text-muted-foreground"
						numberOfLines={1}
					>
						{item.group.connectionLabel} · {item.group.displayPath}
					</Text>
				</View>
			</Pressable>
		);
	}

	if (item.type === "show-more") {
		const label =
			item.hiddenCount > 0 ? `Show ${item.hiddenCount} more` : "Show less";
		return (
			<View className="flex-row gap-2 rounded-b-2xl border-x border-b border-border bg-card px-4 py-3 pl-14">
				{item.hiddenCount > 0 ? (
					<Button
						size="sm"
						variant="secondary"
						onPress={() => updateGroup(item.groupKey, "show-more")}
					>
						{label}
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
	}

	const isActive =
		item.row.status === "running" || item.row.status === "booting";
	const href =
		`/c/${encodeURIComponent(item.row.connectionKey)}/session/${encodeURIComponent(
			item.row.session.id,
		)}` as const;
	return (
		<Swipeable
			friction={2}
			rightThreshold={54}
			overshootRight={false}
			enableTrackpadTwoFingerGesture
			renderRightActions={(_, __, methods) => (
				<Pressable
					accessibilityRole="button"
					accessibilityLabel="Archive chat"
					className={cn(
						"w-24 items-center justify-center border-t border-danger/25 bg-danger/25",
						item.isLast && "rounded-br-2xl border-b",
					)}
					style={item.isLast ? { borderCurve: "continuous" } : undefined}
					onPress={() => {
						methods.close();
						void onArchiveRow(item);
					}}
				>
					<Archive size={20} color={colors.danger} strokeWidth={2.2} />
					<Text className="mt-1 font-sans-medium text-[12px] text-danger">
						Archive
					</Text>
				</Pressable>
			)}
		>
			<Link href={href} asChild>
				<Link.Trigger>
					<Pressable
						className={cn(
							"min-h-[64px] flex-row items-center gap-2.5 border-x border-t border-border bg-card px-3 py-3 active:bg-card-elevated",
							item.isLast && "rounded-b-2xl border-b",
						)}
						style={item.isLast ? { borderCurve: "continuous" } : undefined}
					>
						<View
							collapsable={false}
							className="w-4 items-center justify-center"
						>
							{item.row.pinned ? (
								<Pin size={12} color={colors.secondaryFg} />
							) : isActive ? (
								<PresenceDot tone="online" pulse size={7} />
							) : item.row.unread ? (
								<View className="h-[7px] w-[7px] rounded-full bg-primary" />
							) : null}
						</View>
						<View className="min-w-0 flex-1">
							<Text
								className={cn(
									"font-sans-medium text-[15px]",
									item.row.unread ? "text-foreground" : "text-muted-foreground",
								)}
								numberOfLines={1}
							>
								{item.row.title}
							</Text>
							<View className="mt-0.5 flex-row items-center gap-2">
								<Text
									className="min-w-0 flex-1 font-sans text-[12px] text-muted-foreground"
									numberOfLines={1}
								>
									{item.row.threadLabel}
									{item.row.runningCount > 0
										? ` · ${item.row.runningCount} running`
										: ""}
									{item.row.threadCount > 1
										? ` · ${item.row.threadCount} threads`
										: ""}
									{item.row.subtitle.length > 0
										? ` · ${item.row.subtitle}`
										: ""}
								</Text>
								<BranchStateBadge state={branchState} />
							</View>
						</View>
						<ChevronRight size={17} color={colors.tertiaryFg} />
					</Pressable>
				</Link.Trigger>
			</Link>
		</Swipeable>
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

function BranchStateBadge({
	state,
}: {
	state: ReturnType<typeof branchStatePresentation>;
}) {
	if (state === null) return null;
	return (
		<View
			className={cn(
				"max-w-[112px] flex-row items-center gap-1 rounded-full px-2 py-0.5",
				state.tone === "brand" && "bg-primary/15",
				state.tone === "success" && "bg-success/15",
				state.tone === "danger" && "bg-danger/15",
				state.tone === "warning" && "bg-warning/15",
				state.tone === "neutral" && "bg-muted",
			)}
		>
			<BranchGlyph color={branchToneColor(state.tone)} icon={state.icon} />
			<Text
				className={cn(
					"font-sans-medium text-[11px]",
					state.tone === "brand" && "text-primary",
					state.tone === "success" && "text-success",
					state.tone === "danger" && "text-danger",
					state.tone === "warning" && "text-warning",
					state.tone === "neutral" && "text-muted-foreground",
				)}
				numberOfLines={1}
			>
				{state.label}
			</Text>
		</View>
	);
}

function BranchGlyph({
	color,
	icon,
}: {
	color: ColorValue;
	icon: NonNullable<ReturnType<typeof branchStatePresentation>>["icon"];
}) {
	if (icon === "warning" || icon === "closed") {
		return (
			<View className="h-3 w-3 items-center justify-center">
				<Text
					className="font-sans-bold text-[10px]"
					style={{ color, lineHeight: 12 }}
				>
					{icon === "warning" ? "!" : "x"}
				</Text>
			</View>
		);
	}
	return (
		<View style={{ width: 12, height: 12 }}>
			<View
				style={{
					position: "absolute",
					left: 2,
					top: 2,
					width: 4,
					height: 4,
					borderRadius: 2,
					borderWidth: 1.4,
					borderColor: color,
				}}
			/>
			<View
				style={{
					position: "absolute",
					right: 1,
					bottom: 1,
					width: 4,
					height: 4,
					borderRadius: 2,
					borderWidth: 1.4,
					borderColor: color,
				}}
			/>
			<View
				style={{
					position: "absolute",
					left: 4,
					top: 6,
					width: 1.4,
					height: 4,
					borderRadius: 1,
					backgroundColor: color,
				}}
			/>
			<View
				style={{
					position: "absolute",
					left: 5,
					top: 8,
					width: 4,
					height: 1.4,
					borderRadius: 1,
					backgroundColor: color,
				}}
			/>
		</View>
	);
}

function branchToneColor(
	tone: "brand" | "neutral" | "danger" | "success" | "warning",
) {
	switch (tone) {
		case "brand":
			return colors.accent;
		case "success":
			return colors.success;
		case "danger":
			return colors.danger;
		case "warning":
			return colors.warning;
		case "neutral":
			return colors.secondaryFg;
	}
}

function ProjectLogo({
	title,
	avatarUrl,
}: {
	title: string;
	avatarUrl: string | null;
}) {
	const [failed, setFailed] = useState(false);
	const source = failed ? null : avatarUrl;
	return (
		<View
			className="h-10 w-10 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted"
			style={{ borderCurve: "continuous" }}
		>
			{source ? (
				<Image
					source={{ uri: source }}
					className="h-full w-full"
					resizeMode="cover"
					onError={() => setFailed(true)}
				/>
			) : (
				<Text className="font-sans-bold text-[15px] text-primary">
					{(title.trim()[0] ?? "P").toUpperCase()}
				</Text>
			)}
		</View>
	);
}
