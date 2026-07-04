import { useEffect, useMemo, useRef } from "react";
import { useLocalSearchParams } from "expo-router";
import { FlatList, Text, View } from "react-native";
import type { SessionId } from "@zuse/wire";

import { ComposerStub } from "~/components/composer-stub";
import { MessageRow } from "~/components/messages/message-row";
import { normalizeConnParam, optionsForConnection } from "~/lib/connection-params";
import { useConnectionsStore } from "~/store/connections";
import { selectSessionChat, useSessionsStore } from "~/store/sessions";
import { useMobileMessagesStore } from "~/store/messages";

export default function ThreadScreen() {
  const { conn, sessionId } = useLocalSearchParams<{ conn: string; sessionId: string }>();
  const connKey = normalizeConnParam(conn);
  const normalizedSessionId = normalizeConnParam(sessionId) as SessionId;
  const listRef = useRef<FlatList>(null);
  const { connections, hydrated, hydrate: hydrateConnections } = useConnectionsStore();
  const options = useMemo(
    () => optionsForConnection(connKey, connections),
    [connKey, connections]
  );
  const bundles = useSessionsStore((state) => state.bundlesByConnection[connKey] ?? []);
  const { messagesBySession, reconnectingBySession, errorBySession, hydrate } =
    useMobileMessagesStore();
  const messages = messagesBySession[normalizedSessionId] ?? [];
  const detail = selectSessionChat(bundles, normalizedSessionId);

  useEffect(() => {
    if (!hydrated) void hydrateConnections();
  }, [hydrateConnections, hydrated]);

  useEffect(() => {
    if (normalizedSessionId.length > 0) {
      void hydrate(connKey, options, normalizedSessionId);
    }
  }, [connKey, hydrate, normalizedSessionId, options]);

  return (
    <View className="flex-1 bg-background">
      <View className="border-b border-border px-4 pb-3">
        <Text className="font-sans-medium text-base text-foreground" numberOfLines={1}>
          {detail?.chat?.title ?? detail?.session.title ?? "Thread"}
        </Text>
        <Text className="mt-1 font-sans text-xs text-muted-foreground" numberOfLines={1}>
          {normalizedSessionId}
        </Text>
        {reconnectingBySession[normalizedSessionId] ? (
          <Text className="mt-1 font-sans text-xs text-warning">Reconnecting</Text>
        ) : null}
        {errorBySession[normalizedSessionId] ? (
          <Text className="mt-1 font-sans text-xs text-danger">
            {errorBySession[normalizedSessionId]}
          </Text>
        ) : null}
      </View>
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(message) => message.id}
        renderItem={({ item }) => <MessageRow message={item} />}
        contentContainerClassName="py-3"
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
      />
      <ComposerStub />
    </View>
  );
}
