import { useEffect, useMemo, useRef } from "react";
import { Stack, useLocalSearchParams } from "expo-router";
import { FlatList, KeyboardAvoidingView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SessionId } from "@zuse/wire";

import { ComposerStub } from "~/components/composer-stub";
import { MessageRow } from "~/components/messages/message-row";
import { normalizeConnParam, optionsForConnection } from "~/lib/connection-params";
import { useConnectionsStore } from "~/store/connections";
import { selectSessionChat, useSessionsStore } from "~/store/sessions";
import { useMobileMessagesStore } from "~/store/messages";

export default function ThreadScreen() {
  const insets = useSafeAreaInsets();
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
  const title = detail?.chat?.title ?? detail?.session.title ?? "Thread";

  useEffect(() => {
    if (!hydrated) void hydrateConnections();
  }, [hydrateConnections, hydrated]);

  useEffect(() => {
    if (normalizedSessionId.length > 0) {
      void hydrate(connKey, options, normalizedSessionId);
    }
  }, [connKey, hydrate, normalizedSessionId, options]);

  const reconnecting = reconnectingBySession[normalizedSessionId];
  const error = errorBySession[normalizedSessionId];

  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-background">
      <Stack.Screen options={{ title }} />
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(message) => message.id}
        renderItem={({ item }) => <MessageRow message={item} />}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-1 px-4 py-3"
        ListHeaderComponent={
          reconnecting || error ? (
            <View className="pb-2">
              {reconnecting ? (
                <Text className="font-sans text-[13px] text-warning">
                  Reconnecting…
                </Text>
              ) : null}
              {error ? (
                <Text selectable className="font-sans text-[13px] text-danger">
                  {error}
                </Text>
              ) : null}
            </View>
          ) : null
        }
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
      />
      <ComposerStub
        connection={options}
        sessionId={normalizedSessionId}
        bottomInset={insets.bottom}
      />
    </KeyboardAvoidingView>
  );
}
