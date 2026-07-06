import { useCallback, useEffect, useMemo, useState } from "react";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { MessageSquare } from "lucide-react-native";
import { RefreshControl, ScrollView, Text, View } from "react-native";

import { SessionRow } from "~/components/session-row";
import { EmptyState } from "~/components/ui/empty-state";
import { ListSection } from "~/components/ui/list";
import { normalizeConnParam, optionsForConnection } from "~/lib/connection-params";
import { useConnectionsStore } from "~/store/connections";
import {
  connectionStatusLabel,
  useConnectionRuntimeStore,
} from "~/store/connection-runtime";
import { isUnread, useSessionsStore } from "~/store/sessions";

const ACCENT = "hsl(72 98% 54%)";

export default function SessionsScreen() {
  const { conn } = useLocalSearchParams<{ conn: string }>();
  const connKey = normalizeConnParam(conn);
  const [search, setSearch] = useState("");
  const { connections, hydrated, hydrate: hydrateConnections } = useConnectionsStore();
  const {
    bundlesByConnection,
    statusBySession,
    errorByConnection,
    loadingByConnection,
    hydrate
  } = useSessionsStore();
  const options = useMemo(
    () => optionsForConnection(connKey, connections),
    [connKey, connections]
  );
  const watchConnection = useConnectionRuntimeStore((state) => state.watch);
  const connectionSnapshot = useConnectionRuntimeStore(
    (state) => state.snapshotsByConnection[connKey]
  );
  const bundles = useMemo(
    () => bundlesByConnection[connKey] ?? [],
    [bundlesByConnection, connKey]
  );
  const onChangeSearch = useCallback((event: { nativeEvent: { text: string } }) => {
    setSearch(event.nativeEvent.text);
  }, []);
  const searchOptions = useMemo(
    () => ({
      placeholder: "Search sessions",
      placement: "stacked" as const,
      hideWhenScrolling: false,
      onChangeText: onChangeSearch,
      onCancelButtonPress: () => setSearch(""),
    }),
    [onChangeSearch]
  );

  useEffect(() => {
    if (!hydrated) void hydrateConnections();
  }, [hydrateConnections, hydrated]);

  useEffect(() => {
    if (connKey.length === 0) return;
    return watchConnection(connKey, options);
  }, [connKey, options, watchConnection]);

  useEffect(() => {
    if (connKey.length > 0) void hydrate(connKey, options);
  }, [connKey, connectionSnapshot?.generation, hydrate, options]);

  const rows = useMemo(
    () =>
      bundles.flatMap((bundle) =>
        bundle.sessions.map((session) => {
          const chat = bundle.chats.find((item) => item.id === session.chatId);
          return { project: bundle.project, session, chat };
        })
      ),
    [bundles]
  );
  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query.length === 0) return rows;
    return rows.filter(({ project, session, chat }) => {
      const haystack = [
        project.name,
        project.path,
        session.title,
        session.providerId,
        session.model,
        session.status,
        chat?.title,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [rows, search]);

  const isSearching = search.trim().length > 0;

  return (
    <>
      <Stack.Screen
        options={{
          title: "Sessions",
          headerSearchBarOptions: searchOptions,
        }}
      />
      <ScrollView
        className="flex-1 bg-background"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 p-4 pb-16"
        refreshControl={
          <RefreshControl
            refreshing={loadingByConnection[connKey] === true}
            onRefresh={() => void hydrate(connKey, options)}
            tintColor={ACCENT}
          />
        }
      >
        {errorByConnection[connKey] ? (
          <Text selectable className="px-4 font-sans text-[13px] text-danger">
            {errorByConnection[connKey]}
          </Text>
        ) : null}
        {connectionSnapshot?.status !== undefined &&
        connectionSnapshot.status !== "connected" ? (
          <Text className="px-4 font-sans text-[13px] text-warning">
            {connectionStatusLabel(connectionSnapshot)}
            {connectionSnapshot.error ? `: ${connectionSnapshot.error}` : ""}
          </Text>
        ) : null}

        {filteredRows.length === 0 ? (
          <View className="pt-24">
            <EmptyState
              icon={MessageSquare}
              title={isSearching ? "No matches" : "No sessions"}
              detail={
                isSearching
                  ? "Try another title, project, model, or status."
                  : "Cached sessions appear here first, then refresh over WebSocket."
              }
            />
          </View>
        ) : (
          <ListSection header={connKey}>
            {filteredRows.map(({ session, chat }) => (
              <SessionRow
                key={session.id}
                session={session}
                chat={chat}
                status={statusBySession[session.id]}
                unread={chat !== undefined && isUnread(chat)}
                onPress={() =>
                  router.push(
                    `/c/${encodeURIComponent(connKey)}/session/${encodeURIComponent(session.id)}`
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
