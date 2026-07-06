import { useCallback, useEffect, useMemo, useRef } from "react";
import { Stack, useLocalSearchParams } from "expo-router";
import { FlatList, KeyboardAvoidingView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SessionId, UserQuestion } from "@zuse/wire";
import { Effect } from "effect";

import { Composer } from "~/components/composer";
import {
  MessageRow,
  type MessageRowContext
} from "~/components/messages/message-row";
import { PendingApprovalCard } from "~/components/messages/pending-approval-card";
import { normalizeConnParam, optionsForConnection } from "~/lib/connection-params";
import { answerQuestion } from "~/rpc/actions";
import { useConnectionsStore } from "~/store/connections";
import { selectSessionChat, useSessionsStore } from "~/store/sessions";
import { useMobileMessagesStore } from "~/store/messages";
import { useOutboxStore } from "~/store/outbox";
import { usePermissionsStore } from "~/store/permissions";

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
  const messages = useMemo(
    () => messagesBySession[normalizedSessionId] ?? [],
    [messagesBySession, normalizedSessionId]
  );
  const detail = selectSessionChat(bundles, normalizedSessionId);
  const title = detail?.chat?.title ?? detail?.session.title ?? "Thread";

  const hydratePermissions = usePermissionsStore((state) => state.hydrate);
  const decidePermission = usePermissionsStore((state) => state.decide);
  const pending = usePermissionsStore(
    (state) => state.pendingBySession[normalizedSessionId] ?? []
  );
  const hydrateOutbox = useOutboxStore((state) => state.hydrate);
  const flushOutbox = useOutboxStore((state) => state.flush);
  const queued = useOutboxStore(
    (state) => state.queuedBySession[normalizedSessionId] ?? []
  );

  useEffect(() => {
    if (!hydrated) void hydrateConnections();
  }, [hydrateConnections, hydrated]);

  useEffect(() => {
    if (normalizedSessionId.length > 0) {
      void hydrate(connKey, options, normalizedSessionId);
      void hydratePermissions(connKey, options, normalizedSessionId);
      void hydrateOutbox(connKey, normalizedSessionId);
    }
  }, [connKey, hydrate, hydrateOutbox, hydratePermissions, normalizedSessionId, options]);

  const reconnecting = reconnectingBySession[normalizedSessionId];
  const error = errorBySession[normalizedSessionId];
  const online = reconnecting !== true && (error ?? null) === null;

  // Drain the outbox in order the moment the session is back online.
  useEffect(() => {
    if (online && normalizedSessionId.length > 0) {
      void flushOutbox(connKey, options, normalizedSessionId);
    }
  }, [connKey, flushOutbox, normalizedSessionId, online, options]);

  // Cross-reference question rows so answered prompts collapse and the answer
  // row can resolve selected option labels.
  const { answeredQuestionIds, questionsByItemId } = useMemo(() => {
    const answered = new Set<string>();
    const questions = new Map<string, readonly UserQuestion[]>();
    for (const message of messages) {
      const content = message.content;
      if (content._tag === "user_question") {
        questions.set(content.itemId, content.questions);
      } else if (content._tag === "user_question_answer") {
        answered.add(content.itemId);
      }
    }
    return { answeredQuestionIds: answered, questionsByItemId: questions };
  }, [messages]);

  const onAnswerQuestion = useCallback<MessageRowContext["onAnswerQuestion"]>(
    (itemId, answers) =>
      Effect.runPromise(
        answerQuestion({
          connection: options,
          sessionId: normalizedSessionId,
          itemId,
          answers
        })
      ).catch(() => {}),
    [normalizedSessionId, options]
  );

  const ctx = useMemo<MessageRowContext>(
    () => ({ answeredQuestionIds, questionsByItemId, onAnswerQuestion }),
    [answeredQuestionIds, questionsByItemId, onAnswerQuestion]
  );

  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-background">
      <Stack.Screen options={{ title }} />
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(message) => message.id}
        renderItem={({ item }) => <MessageRow message={item} ctx={ctx} />}
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
        ListFooterComponent={
          queued.length > 0 || pending.length > 0 ? (
            <View className="pt-1">
              {queued.map((item) => (
                <QueuedBubble key={item.clientId} text={item.text} />
              ))}
              {pending.map((request) => (
                <PendingApprovalCard
                  key={request.id}
                  request={request}
                  onDecide={(decision) =>
                    decidePermission(options, normalizedSessionId, request.id, decision)
                  }
                />
              ))}
            </View>
          ) : null
        }
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
      />
      <Composer
        connKey={connKey}
        connection={options}
        sessionId={normalizedSessionId}
        bottomInset={insets.bottom}
      />
    </KeyboardAvoidingView>
  );
}

const QueuedBubble = ({ text }: { text: string }) => (
  <View className="items-end px-3 py-1.5">
    <View className="max-w-[88%] rounded-lg border border-primary/40 bg-primary/20 px-3 py-2">
      <Text className="mb-0.5 font-sans-medium text-[11px] text-warning">Queued</Text>
      <Text className="font-sans text-[15px] leading-5 text-foreground">{text}</Text>
    </View>
  </View>
);
