import { useEffect, useMemo } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { MessageSquare } from "lucide-react-native";
import { ScrollView, Text, View } from "react-native";

import { SessionRow } from "~/components/session-row";
import { EmptyState } from "~/components/ui/empty-state";
import { normalizeConnParam, optionsForConnection } from "~/lib/connection-params";
import { useConnectionsStore } from "~/store/connections";
import { isUnread, useSessionsStore } from "~/store/sessions";

export default function SessionsScreen() {
  const { conn } = useLocalSearchParams<{ conn: string }>();
  const connKey = normalizeConnParam(conn);
  const { connections, hydrated, hydrate: hydrateConnections } = useConnectionsStore();
  const { bundlesByConnection, statusBySession, errorByConnection, loadingByConnection, hydrate } =
    useSessionsStore();
  const options = useMemo(
    () => optionsForConnection(connKey, connections),
    [connKey, connections]
  );
  const bundles = bundlesByConnection[connKey] ?? [];

  useEffect(() => {
    if (!hydrated) void hydrateConnections();
  }, [hydrateConnections, hydrated]);

  useEffect(() => {
    if (connKey.length > 0) void hydrate(connKey, options);
  }, [connKey, hydrate, options]);

  const rows = bundles.flatMap((bundle) =>
    bundle.sessions.map((session) => {
      const chat = bundle.chats.find((item) => item.id === session.chatId);
      return { project: bundle.project, session, chat };
    })
  );

  return (
    <View className="flex-1 bg-background">
      <View className="border-b border-border px-4 pb-3">
        <Text className="font-sans text-xs text-muted-foreground">{connKey}</Text>
        {loadingByConnection[connKey] === true ? (
          <Text className="mt-1 font-sans text-xs text-primary">Refreshing</Text>
        ) : null}
        {errorByConnection[connKey] ? (
          <Text className="mt-1 font-sans text-xs text-danger">{errorByConnection[connKey]}</Text>
        ) : null}
      </View>
      {rows.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="No sessions"
          detail="Cached sessions appear here first, then refresh over WebSocket."
        />
      ) : (
        <ScrollView contentContainerClassName="gap-3 p-4">
          {rows.map(({ session, chat }) => (
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
        </ScrollView>
      )}
    </View>
  );
}
