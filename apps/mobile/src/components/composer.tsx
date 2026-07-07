import type { Session, SessionId, SessionStatus } from "@zuse/wire";
import {
  ArrowUp01Icon,
  CloudOffIcon,
  CancelCircleIcon,
  Folder01Icon,
  GitBranchIcon,
  Square01Icon,
} from "@hugeicons-pro/core-solid-rounded";
import { Effect } from "effect";
import { useState } from "react";
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
  sendMessage,
  setSessionModel,
  setSessionPermissionMode,
  setSessionProvider,
  setSessionRuntimeMode,
} from "~/rpc/actions";
import { isInterruptVisible } from "~/lib/composer-state";
import { connectionSessionKey } from "~/lib/session-key";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";
import { useMobileMessagesStore } from "~/store/messages";
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
  projectLabel,
  sourceLabel,
  bottomInset = 0,
}: {
  connKey: string;
  connection: WsProtocolOptions;
  sessionId: SessionId;
  session: Session | null;
  status?: SessionStatus;
  fresh: boolean;
  projectLabel?: string;
  sourceLabel?: string;
  bottomInset?: number;
}) => {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const stateKey = connectionSessionKey(connKey, sessionId);

  // Offline = the message stream is retrying or has surfaced an error. Sends
  // made in this state are queued instead of dropped.
  const online = useMobileMessagesStore(
    (state) =>
      state.reconnectingBySession[stateKey] !== true &&
      (state.errorBySession[stateKey] ?? null) === null,
  );
  const queuedCount = useOutboxStore(
    (state) => (state.queuedBySession[stateKey] ?? []).length,
  );
  const enqueue = useOutboxStore((state) => state.enqueue);

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
    try {
      await Effect.runPromise(
        sendMessage({ connection, sessionId, input: makeTextInput(value) }),
      );
    } catch {
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
    if (session === null || !fresh) return;
    try {
      if (next.providerId !== session.providerId) {
        await Effect.runPromise(
          setSessionProvider({
            connection,
            sessionId,
            providerId: next.providerId,
            model: next.model,
          }),
        );
      } else if (next.model !== session.model) {
        await Effect.runPromise(
          setSessionModel({ connection, sessionId, model: next.model }),
        );
      }
      if (next.runtimeMode !== session.runtimeMode) {
        await Effect.runPromise(
          setSessionRuntimeMode({
            connection,
            sessionId,
            runtimeMode: next.runtimeMode,
          }),
        );
      }
      if (next.permissionMode !== session.permissionMode) {
        await Effect.runPromise(
          setSessionPermissionMode({
            connection,
            sessionId,
            mode: next.permissionMode,
          }),
        );
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
            {queuedCount} queued · will send when reconnected
          </Text>
        </View>
      ) : null}
      {projectLabel !== undefined || sourceLabel !== undefined ? (
        <View className="mb-2 flex-row items-center gap-2 px-1">
          {projectLabel !== undefined ? (
            <ChromeLabel icon="project" label={projectLabel} />
          ) : null}
          {sourceLabel !== undefined ? (
            <ChromeLabel icon="branch" label={sourceLabel} />
          ) : null}
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
            editable={fresh}
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
                editable={fresh}
                onChange={(next) => void changeModelMode(next)}
              />
              <View className="min-w-0 flex-1 items-center">
                <ComposerModelMenu
                  value={modelValue}
                  editable={fresh}
                  onChange={(next) => void changeModelMode(next)}
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

const ChromeLabel = ({
  icon,
  label,
}: {
  icon: "project" | "branch";
  label: string;
}) => (
  <View className="min-w-0 flex-1 flex-row items-center gap-1.5 rounded-full bg-card-elevated/70 px-2.5 py-1.5">
    {icon === "project" ? (
      <HugeIcon icon={Folder01Icon} size={13} color="hsl(72 4% 76%)" />
    ) : (
      <HugeIcon icon={GitBranchIcon} size={13} color="hsl(72 4% 76%)" />
    )}
    <Text
      className="min-w-0 flex-1 font-sans-medium text-[12px] text-muted-foreground"
      numberOfLines={1}
    >
      {label}
    </Text>
  </View>
);

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
