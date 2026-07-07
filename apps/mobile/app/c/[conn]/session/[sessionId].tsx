import { useCallback, useEffect, useMemo, useRef } from "react";
import { Stack, useLocalSearchParams } from "expo-router";
import { FlatList, KeyboardAvoidingView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SessionId, UserQuestion } from "@zuse/wire";
import { Effect } from "effect";

import { Composer } from "~/components/composer";
import { LivePermissionAccessory } from "~/components/messages/live-permission-accessory";
import {
  MessageRow,
  type MessageRowContext,
} from "~/components/messages/message-row";
import {
  normalizeConnParam,
  optionsForConnection,
} from "~/lib/connection-params";
import { connectionSessionKey } from "~/lib/session-key";
import { answerQuestion } from "~/rpc/actions";
import { buildToolResultsByItemId } from "~/lib/message-presentation";
import { useConnectionsStore } from "~/store/connections";
import {
  connectionStatusLabel,
  useConnectionRuntimeStore,
} from "~/store/connection-runtime";
import { selectSessionChat, useSessionsStore } from "~/store/sessions";
import { useMobileMessagesStore } from "~/store/messages";
import { useOutboxStore } from "~/store/outbox";
import { usePermissionsStore } from "~/store/permissions";

const EMPTY_BUNDLES: ReturnType<
  typeof useSessionsStore.getState
>["bundlesByConnection"][string] = [];
const EMPTY_PENDING: ReturnType<
  typeof usePermissionsStore.getState
>["pendingBySession"][string] = [];
const EMPTY_QUEUED: ReturnType<
  typeof useOutboxStore.getState
>["queuedBySession"][string] = [];
const EMPTY_MESSAGES: ReturnType<
  typeof useMobileMessagesStore.getState
>["messagesBySession"][string] = [];

export default function ThreadScreen() {
  const insets = useSafeAreaInsets();
  const { conn, sessionId } = useLocalSearchParams<{
    conn: string;
    sessionId: string;
  }>();
  const connKey = normalizeConnParam(conn);
  const normalizedSessionId = normalizeConnParam(sessionId) as SessionId;
  const listRef = useRef<FlatList>(null);
  const didInitialScroll = useRef(false);
  const initialScrollQuietUntil = useRef(0);
  const {
    connections,
    hydrated,
    hydrate: hydrateConnections,
  } = useConnectionsStore();
  const options = useMemo(
    () => optionsForConnection(connKey, connections),
    [connKey, connections],
  );
  const stateKey = connectionSessionKey(connKey, normalizedSessionId);
  const watchConnection = useConnectionRuntimeStore((state) => state.watch);
  const connectionSnapshot = useConnectionRuntimeStore(
    (state) => state.snapshotsByConnection[connKey],
  );
  const bundles = useSessionsStore(
    (state) => state.bundlesByConnection[connKey] ?? EMPTY_BUNDLES,
  );
  const { messagesBySession, reconnectingBySession, errorBySession, hydrate } =
    useMobileMessagesStore();
  const messages = messagesBySession[stateKey] ?? EMPTY_MESSAGES;
  const detail = selectSessionChat(bundles, normalizedSessionId);
  const title = detail?.chat?.title ?? detail?.session.title ?? "Thread";

  const hydratePermissions = usePermissionsStore((state) => state.hydrate);
  const decidePermission = usePermissionsStore((state) => state.decide);
  const pending = usePermissionsStore(
    (state) => state.pendingBySession[stateKey] ?? EMPTY_PENDING,
  );
  const hydrateOutbox = useOutboxStore((state) => state.hydrate);
  const flushOutbox = useOutboxStore((state) => state.flush);
  const queued = useOutboxStore(
    (state) => state.queuedBySession[stateKey] ?? EMPTY_QUEUED,
  );

  useEffect(() => {
    if (!hydrated) void hydrateConnections();
  }, [hydrateConnections, hydrated]);

  useEffect(() => {
    if (connKey.length === 0 || options === null) return;
    return watchConnection(connKey, options);
  }, [connKey, options, watchConnection]);

  useEffect(() => {
    if (normalizedSessionId.length > 0 && options !== null) {
      void hydrate(connKey, options, normalizedSessionId);
      void hydratePermissions(connKey, options, normalizedSessionId);
      void hydrateOutbox(connKey, normalizedSessionId);
    }
  }, [
    connKey,
    connectionSnapshot?.generation,
    hydrate,
    hydrateOutbox,
    hydratePermissions,
    normalizedSessionId,
    options,
  ]);

  const reconnecting = reconnectingBySession[stateKey];
  const error = errorBySession[stateKey];
  const online =
    connectionSnapshot?.status === "connected" &&
    reconnecting !== true &&
    (error ?? null) === null;

  // Drain the outbox in order the moment the session is back online.
  useEffect(() => {
    if (online && normalizedSessionId.length > 0 && options !== null) {
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
  const toolResultsByItemId = useMemo(
    () => buildToolResultsByItemId(messages),
    [messages],
  );

  const onAnswerQuestion = useCallback<MessageRowContext["onAnswerQuestion"]>(
    (itemId, answers) =>
      options === null
        ? Promise.resolve()
        : Effect.runPromise(
            answerQuestion({
              connection: options,
              sessionId: normalizedSessionId,
              itemId,
              answers,
            }),
          ).catch(() => {}),
    [normalizedSessionId, options],
  );

  const ctx = useMemo<MessageRowContext>(
    () => ({
      answeredQuestionIds,
      questionsByItemId,
      toolResultsByItemId,
      onAnswerQuestion,
    }),
    [
      answeredQuestionIds,
      onAnswerQuestion,
      questionsByItemId,
      toolResultsByItemId,
    ],
  );

  useEffect(() => {
    didInitialScroll.current = false;
    initialScrollQuietUntil.current = Date.now() + 500;
  }, [stateKey]);

  const scrollToLatest = useCallback(() => {
    if (messages.length === 0) return;
    const animated =
      didInitialScroll.current && Date.now() > initialScrollQuietUntil.current;
    didInitialScroll.current = true;
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated });
    });
  }, [messages.length]);

  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-background">
      <Stack.Screen options={{ title }} />
      {hydrated && options === null ? (
        <View className="px-4 py-3">
          <Text selectable className="font-sans text-[13px] text-danger">
            This saved connection could not be found on this phone. Go back and
            connect the computer again.
          </Text>
        </View>
      ) : null}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(message) => message.id}
        renderItem={({ item }) => <MessageRow message={item} ctx={ctx} />}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-1 px-4 py-3"
        ListHeaderComponent={
          reconnecting ||
          error ||
          connectionSnapshot?.status !== "connected" ? (
            <View className="pb-2">
              {connectionSnapshot?.status !== "connected" ? (
                <Text className="font-sans text-[13px] text-warning">
                  {connectionStatusLabel(connectionSnapshot)}
                  {connectionSnapshot?.error
                    ? `: ${connectionSnapshot.error}`
                    : ""}
                </Text>
              ) : null}
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
          queued.length > 0 ? (
            <View className="pt-1">
              {queued.map((item) => (
                <QueuedBubble key={item.clientId} text={item.text} />
              ))}
            </View>
          ) : null
        }
        onContentSizeChange={scrollToLatest}
        onLayout={scrollToLatest}
      />
      {options === null || pending.length === 0 ? null : (
        <LivePermissionAccessory
          requests={pending}
          bottomInset={0}
          onDecide={(request, decision) =>
            decidePermission(
              connKey,
              options,
              normalizedSessionId,
              request.id,
              decision,
            )
          }
        />
      )}
      {options === null ? null : (
        <Composer
          connKey={connKey}
          connection={options}
          sessionId={normalizedSessionId}
          bottomInset={insets.bottom}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const QueuedBubble = ({ text }: { text: string }) => (
  <View className="items-end px-3 py-1.5">
    <View
      style={{ borderCurve: "continuous" }}
      className="max-w-[88%] rounded-2xl border border-primary/40 bg-primary/15 px-3 py-2"
    >
      <Text className="mb-0.5 font-sans-medium text-[11px] text-warning">
        Queued
      </Text>
      <Text className="font-sans text-[15px] leading-5 text-foreground">
        {text}
      </Text>
    </View>
  </View>
);
