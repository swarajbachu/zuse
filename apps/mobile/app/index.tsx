import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, router, Stack } from "expo-router";
import {
  AlertTriangle,
  Archive,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  LoaderCircle,
  Loader2,
  MessageCircle,
  MessageSquare,
  Search,
  Settings,
  X,
} from "lucide-react-native";
import {
  ActivityIndicator,
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
import type { SessionStatus } from "@zuse/wire";

import {
  buildInboxGroups,
  buildInboxListItems,
  DEFAULT_INBOX_GROUP_DISPLAY,
  nextInboxGroupDisplay,
  type InboxDisplayAction,
  type InboxGroupDisplayState,
  type InboxListItem,
} from "~/lib/inbox";
import { optionsForConnection } from "~/lib/connection-params";
import { cn } from "~/lib/cn";
import { githubOwnerAvatarUrl } from "~/lib/display-names";
import { branchStatePresentation } from "~/lib/pr-state-presentation";
import { selectionTap, successTap } from "~/lib/haptics";
import { useAuthStore } from "~/store/auth";
import {
  connectionStatusLabel,
  useConnectionRuntimeStore,
} from "~/store/connection-runtime";
import { useConnectionsStore } from "~/store/connections";
import { useEnvironmentsStore } from "~/store/environments";
import { useSessionsStore } from "~/store/sessions";
import { prStateKey, usePrStateStore } from "~/store/pr-state";
import {
  projectOriginKey,
  useProjectOriginStore,
} from "~/store/project-origins";
import { EmptyState } from "~/components/ui/empty-state";
import { Button } from "~/components/ui/button";
import { GlassSurface } from "~/components/ui/glass-surface";
import { UnreadBadge } from "~/components/unread-badge";

const ACCENT = "hsl(72 98% 54%)";
const LOGO = require("../assets/icon.png");

export default function HomeScreen() {
  const { width } = useWindowDimensions();
  const [search, setSearch] = useState("");
  const [displayStates, setDisplayStates] = useState<
    ReadonlyMap<string, InboxGroupDisplayState>
  >(() => new Map());
  const connectingEnvironmentIds = useRef(new Set<string>());
  const { account, hydrated: authHydrated, busy, error: authError, hydrate: hydrateAuth, signIn } =
    useAuthStore();
  const {
    connections,
    hydrated: connectionsHydrated,
    hydrate: hydrateConnections,
  } = useConnectionsStore();
  const {
    environments,
    loading: environmentsLoading,
    error: environmentsError,
    refresh: refreshEnvironments,
    connect,
  } = useEnvironmentsStore();
  const watchConnection = useConnectionRuntimeStore((state) => state.watch);
  const snapshots = useConnectionRuntimeStore(
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

  useEffect(() => {
    if (!authHydrated) void hydrateAuth();
  }, [authHydrated, hydrateAuth]);

  useEffect(() => {
    if (!connectionsHydrated) void hydrateConnections();
  }, [connectionsHydrated, hydrateConnections]);

  useEffect(() => {
    if (account !== null) void refreshEnvironments();
  }, [account, refreshEnvironments]);

  useEffect(() => {
    if (account === null) return;
    for (const environment of environments) {
      const alreadyConnected = connections.some(
        (connection) => connection.environmentId === environment.environmentId,
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
    const unwatch = connections.flatMap((connection) => {
      const options = optionsForConnection(connection.key, connections);
      return options === null ? [] : [watchConnection(connection.key, options)];
    });
    return () => {
      for (const stop of unwatch) stop();
    };
  }, [connections, watchConnection]);

  useEffect(() => {
    if (account === null) return;
    for (const connection of connections) {
      const options = optionsForConnection(connection.key, connections);
      if (options === null) continue;
      void hydrateSessions(connection.key, options);
    }
  }, [account, connections, hydrateSessions]);

  const groups = useMemo(
    () =>
      buildInboxGroups({
        connections,
        bundlesByConnection,
        statusBySession,
        query: search,
      }),
    [bundlesByConnection, connections, search, statusBySession],
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
    environmentsLoading ||
    Object.values(loadingByConnection).some(Boolean);
  const connectionError = Object.values(errorByConnection).find(Boolean) ?? null;

  const updateGroup = useCallback((key: string, action: InboxDisplayAction) => {
    selectionTap();
    setDisplayStates((prev) => {
      const next = new Map(prev);
      next.set(
        key,
        nextInboxGroupDisplay(prev.get(key) ?? DEFAULT_INBOX_GROUP_DISPLAY, action),
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
        await archiveSession(row.row.connectionKey, options, row.row.session.id);
      }
    },
    [archiveChat, archiveSession, connections],
  );

  if (!authHydrated) {
    return <View className="flex-1 bg-background" />;
  }

  if (account === null) {
    return (
      <View className="flex-1 bg-background">
        <Stack.Screen
          options={{
            title: "Sign in",
            headerLargeTitle: false,
            headerSearchBarOptions: undefined,
            headerRight: undefined,
          }}
        />
        <View className="flex-1 justify-center gap-6 px-6">
          <View className="gap-3">
            <View className="h-12 w-12 items-center justify-center rounded-2xl bg-card">
              <MessageSquare size={23} color={ACCENT} />
            </View>
            <Text className="font-sans-bold text-[34px] leading-10 text-foreground">
              Sign in to continue
            </Text>
            <Text className="font-sans text-[16px] leading-6 text-muted-foreground">
              Use the same account as your Mac to see your computers, projects,
              and active chats.
            </Text>
          </View>
          {authError ? (
            <Text selectable className="font-sans text-sm leading-5 text-danger">
              {authError}
            </Text>
          ) : null}
          <Button disabled={busy} onPress={() => void signIn()}>
            {busy ? "Signing in..." : "Sign in"}
          </Button>
        </View>
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
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open settings"
              hitSlop={12}
              onPress={() => router.push("/settings")}
            >
              <Settings size={22} color={ACCENT} />
            </Pressable>
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
            <Search size={17} color="hsl(72 2% 64%)" />
            <TextInput
              accessibilityLabel="Search chats"
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-7 flex-1 font-sans text-[16px] text-foreground"
              placeholder="Search"
              placeholderTextColor="hsl(72 4% 56%)"
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
                <X size={16} color="hsl(72 2% 72%)" />
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
            tintColor={ACCENT}
            onRefresh={() => {
              void refreshEnvironments();
              for (const connection of connections) {
                const options = optionsForConnection(connection.key, connections);
                if (options !== null) void hydrateSessions(connection.key, options);
              }
            }}
          />
        }
      >
        {environmentsError ?? connectionError ? (
          <View className="mb-3 rounded-2xl border border-danger/35 bg-danger/10 px-3 py-2">
            <Text selectable className="font-sans text-sm leading-5 text-danger">
              {environmentsError ?? connectionError}
            </Text>
          </View>
        ) : null}

        {listItems.length === 0 ? (
          <View className="pt-24">
            <EmptyState
              icon={search.trim().length > 0 ? Search : MessageSquare}
              title={search.trim().length > 0 ? "No matching chats" : "No chats yet"}
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
                <ActivityIndicator color={ACCENT} />
              </View>
            ) : null}
          </View>
        ) : (
          <View>
            {listItems.map((item) => (
              <InboxItem
                key={item.key}
                item={item}
                snapshots={snapshots}
                connections={connections}
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
  snapshots,
  connections,
  updateGroup,
  onArchiveRow,
}: {
  item: InboxListItem;
  snapshots: ReturnType<typeof useConnectionRuntimeStore.getState>["snapshotsByConnection"];
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
    group === null ? null : projectOriginKey(group.connectionKey, group.projectId);
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
    void hydrateProjectOrigin(group.connectionKey, groupOptions, group.projectId);
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
        <Icon size={18} color="hsl(72 2% 54%)" />
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
                <Loader2 size={11} color="hsl(42 93% 48%)" />
                <Text className="font-sans-medium text-[11px] text-warning">
                  {item.group.activeCount}
                </Text>
              </View>
            ) : null}
            <Text className="font-sans text-[13px] text-muted-foreground">
              {item.group.rows.length}
            </Text>
          </View>
          <Text className="font-sans text-[12px] text-muted-foreground" numberOfLines={1}>
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

  const snapshot = snapshots[item.row.connectionKey];
  const statusLabel =
    snapshot?.status !== undefined && snapshot.status !== "connected"
      ? connectionStatusLabel(snapshot)
      : item.row.status;
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
          <Archive size={20} color="hsl(0 84% 62%)" strokeWidth={2.2} />
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
              "min-h-[72px] flex-row items-center gap-3 border-x border-t border-border bg-card px-3 py-3 active:bg-card-elevated",
              item.isLast && "rounded-b-2xl border-b",
            )}
            style={item.isLast ? { borderCurve: "continuous" } : undefined}
          >
            <Link.AppleZoom>
              <View
                collapsable={false}
                className="h-10 w-10 items-center justify-center rounded-full bg-muted"
              >
                <ChatStateIcon status={item.row.status} />
              </View>
            </Link.AppleZoom>
            <View className="min-w-0 flex-1">
              <View className="flex-row items-center gap-2">
                <Text
                  className="min-w-0 flex-1 font-sans-medium text-[16px] text-foreground"
                  numberOfLines={1}
                >
                  {item.row.title}
                </Text>
                <UnreadBadge visible={item.row.unread} />
              </View>
              <View className="mt-0.5 flex-row items-center gap-2">
                <Text
                  className="min-w-0 flex-1 font-sans text-[13px] text-muted-foreground"
                  numberOfLines={1}
                >
                  {item.row.subtitle} · {statusLabel}
                </Text>
                <BranchStateBadge state={branchState} />
              </View>
            </View>
            <ChevronRight size={17} color="hsl(72 2% 54%)" />
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

function ChatStateIcon({ status }: { status: SessionStatus }) {
  const meta = iconForStatus(status);
  const Icon = meta.icon;
  return (
    <Icon
      size={21}
      color={meta.color}
      strokeWidth={2.1}
    />
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
  color: string;
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

function branchToneColor(tone: "brand" | "neutral" | "danger" | "success" | "warning") {
  switch (tone) {
    case "brand":
      return "hsl(72 98% 54%)";
    case "success":
      return "hsl(142 70% 45%)";
    case "danger":
      return "hsl(0 84% 62%)";
    case "warning":
      return "hsl(42 93% 48%)";
    case "neutral":
      return "hsl(72 3% 64%)";
  }
}

function iconForStatus(status: SessionStatus) {
  switch (status) {
    case "running":
      return { icon: LoaderCircle, color: "hsl(72 98% 54%)" };
    case "error":
      return { icon: AlertTriangle, color: "hsl(0 84% 62%)" };
    case "closed":
      return { icon: CircleX, color: "hsl(72 3% 64%)" };
    case "idle":
      return { icon: CircleCheck, color: "hsl(142 70% 45%)" };
    case "booting":
      return { icon: LoaderCircle, color: "hsl(42 93% 48%)" };
    default:
      return { icon: MessageCircle, color: "hsl(72 4% 70%)" };
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
