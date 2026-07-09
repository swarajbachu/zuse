import {
  Message,
  MessageId,
  type MessageContent,
  type Session,
  type SessionId,
  type SessionStatus,
} from "@zuse/wire";
import {
  ArrowUp01Icon,
  CloudOffIcon,
  CancelCircleIcon,
  Square01Icon,
} from "@hugeicons-pro/core-solid-rounded";
import { Effect } from "effect";
import * as Crypto from "expo-crypto";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  interruptSession,
  makeTextInput,
  flushServerQueue,
  queueMessage,
  sendMessage,
  setSessionModel,
  setSessionPermissionMode,
  setSessionProvider,
  setSessionRuntimeMode,
} from "~/rpc/actions";
import {
  isInterruptVisible,
  nextModelChangeActions,
} from "~/lib/composer-state";
import { availableProviderIds } from "~/lib/model-options";
import { connectionSessionKey } from "~/lib/session-key";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";
import { useAvailabilityStore } from "~/store/availability";
import {
  addOptimisticMessage,
  removeOptimisticMessage,
} from "~/store/messages";
import { useOutboxStore } from "~/store/outbox";
import {
  ComposerModelMenu,
  ComposerSettingsMenu,
  type ModelModeValue,
} from "./model-mode-menu";
import { Button } from "./ui/button";
import { GlassSurface } from "./ui/glass-surface";
import { HugeIcon } from "./ui/huge-icon";

export const Composer = ({
  connKey,
  connection,
  sessionId,
  session,
  status,
  fresh,
  online,
  bottomInset = 0,
}: {
  connKey: string;
  connection: WsProtocolOptions;
  sessionId: SessionId;
  session: Session | null;
  status?: SessionStatus;
  fresh: boolean;
  online: boolean;
  bottomInset?: number;
}) => {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const stateKey = connectionSessionKey(connKey, sessionId);

  const queuedCount = useOutboxStore(
    (state) => (state.queuedBySession[stateKey] ?? []).length,
  );
  const queueSending = useOutboxStore(
    (state) => state.sendingBySession[stateKey] === true,
  );
  const queueError = useOutboxStore(
    (state) => state.errorBySession[stateKey],
  );
  const enqueue = useOutboxStore((state) => state.enqueue);

  const hydrateAvailability = useAvailabilityStore((state) => state.hydrate);
  const availability = useAvailabilityStore(
    (state) => state.availabilityByConnection[connKey],
  );
  useEffect(() => {
    void hydrateAvailability(connKey, connection);
  }, [connKey, connection, hydrateAvailability]);
  const availableProviders = useMemo(
    () => availableProviderIds(availability),
    [availability],
  );

  const canSend = text.trim().length > 0 && !busy;
  const showInterrupt = isInterruptVisible(status);
  const modelValue: ModelModeValue | null =
    session === null
      ? null
      : {
          providerId: session.providerId,
          model: session.model,
          runtimeMode: session.runtimeMode,
          permissionMode: session.permissionMode,
        };

  const submit = async () => {
    if (!canSend) return;
    const value = text.trim();
    setText("");
    if (!online) {
      await enqueue(connKey, sessionId, value);
      return;
    }
    setBusy(true);
    if (showInterrupt) {
      try {
        await Effect.runPromise(
          queueMessage({
            connection,
            sessionId,
            input: makeTextInput(value),
          }),
        );
      } catch (cause) {
        console.warn("[mobile] composer.queue_add_failed", {
          sessionId,
          reason: messageOf(cause),
        });
        await enqueue(connKey, sessionId, value);
        setBusy(false);
        return;
      }
      await Effect.runPromise(flushServerQueue({ connection, sessionId })).catch(
        (cause) => {
          console.warn("[mobile] composer.queue_flush_failed", {
            sessionId,
            reason: messageOf(cause),
          });
        },
      );
      setBusy(false);
      return;
    }
    const messageId = MessageId.make(Crypto.randomUUID());
    const optimisticContent: MessageContent = {
      _tag: "user",
      text: value,
      goal: false,
    };
    addOptimisticMessage(
      stateKey,
      Message.make({
        id: messageId,
        sessionId,
        role: "user",
        content: optimisticContent,
        createdAt: new Date(),
      }),
    );
    try {
      await Effect.runPromise(
        sendMessage({
          connection,
          sessionId,
          input: makeTextInput(value),
          clientMessageId: messageId,
        }),
      );
    } catch {
      removeOptimisticMessage(stateKey, messageId);
      // Lost the connection mid-send — keep the text safe in the outbox.
      await enqueue(connKey, sessionId, value);
    } finally {
      setBusy(false);
    }
  };

  const interrupt = async () => {
    if (!showInterrupt) return;
    setBusy(true);
    try {
      await Effect.runPromise(interruptSession({ connection, sessionId }));
    } finally {
      setBusy(false);
    }
  };

  const changeModelMode = async (next: ModelModeValue) => {
    if (session === null) return;
    const actions = nextModelChangeActions(session, next, fresh);
    try {
      for (const action of actions) {
        switch (action.type) {
          case "setProvider":
            await Effect.runPromise(
              setSessionProvider({
                connection,
                sessionId,
                providerId: action.providerId,
                model: action.model,
              }),
            );
            break;
          case "setModel":
            await Effect.runPromise(
              setSessionModel({ connection, sessionId, model: action.model }),
            );
            break;
          case "setRuntimeMode":
            await Effect.runPromise(
              setSessionRuntimeMode({
                connection,
                sessionId,
                runtimeMode: action.runtimeMode,
              }),
            );
            break;
          case "setPermissionMode":
            await Effect.runPromise(
              setSessionPermissionMode({
                connection,
                sessionId,
                mode: action.permissionMode,
              }),
            );
            break;
        }
      }
    } catch {
      // Started sessions can reject some changes. Keep this quiet on mobile.
    }
  };

  return (
    <View
      className="px-3 pt-2"
      style={{ paddingBottom: bottomInset > 0 ? bottomInset : 12 }}
    >
      {queuedCount > 0 ? (
        <View className="mb-2 flex-row items-center gap-1.5 px-1">
          <HugeIcon icon={CloudOffIcon} size={13} color="hsl(42 93% 56%)" />
          <Text className="font-sans-medium text-xs text-warning">
            {queuedCount} queued ·{" "}
            {online
              ? queueSending
                ? "sending…"
                : queueError ?? "ready to send"
              : "will send when reconnected"}
          </Text>
        </View>
      ) : null}
      <GlassSurface
        style={{
          gap: 8,
          padding: 10,
        }}
      >
        {modelValue?.permissionMode === "plan" ? (
          <PlanPill
            editable
            onClear={() =>
              void changeModelMode({ ...modelValue, permissionMode: "default" })
            }
          />
        ) : null}
        <TextInput
          className="max-h-36 min-h-12 px-1 py-2 font-sans text-[17px] leading-6 text-foreground"
          multiline
          placeholder={online ? "Message" : "Offline · message will queue"}
          placeholderTextColor="hsl(72 4% 56%)"
          value={text}
          onChangeText={setText}
        />
        <View className="flex-row items-center gap-2">
          {modelValue === null ? null : (
            <>
              <ComposerSettingsMenu
                value={modelValue}
                editable
                onChange={(next) => void changeModelMode(next)}
              />
              <View className="min-w-0 flex-1 items-center">
                <ComposerModelMenu
                  value={modelValue}
                  editable
                  onChange={(next) => void changeModelMode(next)}
                  availableProviders={availableProviders}
                  canChangeProvider={fresh}
                  canChangeReasoning={fresh}
                />
              </View>
            </>
          )}
          {showInterrupt ? (
            <Button
              size="sm"
              variant="secondary"
              className="h-10 w-10 rounded-full px-0"
              disabled={busy || !online}
              onPress={interrupt}
            >
              <HugeIcon icon={Square01Icon} size={15} color="hsl(72 4% 92%)" />
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={online ? "primary" : "secondary"}
            className="h-10 w-10 rounded-full px-0"
            disabled={!canSend}
            onPress={submit}
          >
            {busy ? (
              <ActivityIndicator color="hsl(72 5% 6%)" />
            ) : online ? (
              <HugeIcon icon={ArrowUp01Icon} size={16} color="hsl(72 5% 6%)" />
            ) : (
              <HugeIcon icon={CloudOffIcon} size={15} color="hsl(72 4% 92%)" />
            )}
          </Button>
        </View>
      </GlassSurface>
    </View>
  );
};

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const PlanPill = ({
  editable,
  onClear,
}: {
  editable: boolean;
  onClear: () => void;
}) => (
  <View className="self-start flex-row items-center gap-2 rounded-full bg-card-elevated px-3 py-2">
    <Text className="font-sans-medium text-[15px] text-foreground">Plan</Text>
    {editable ? (
      <Pressable accessibilityRole="button" onPress={onClear} hitSlop={8}>
        <HugeIcon icon={CancelCircleIcon} size={15} color="hsl(72 4% 76%)" />
      </Pressable>
    ) : null}
  </View>
);
