import type { PermissionDecision, PermissionRequest } from "@zuse/contracts";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { GlassSurface } from "~/components/ui/glass-surface";
import {
  describePermissionKind,
  permissionQuestion,
} from "~/lib/permission-presentation";

export function LivePermissionAccessory({
  requests,
  bottomInset,
  onDecide,
  onDenyWithMessage,
}: {
  requests: readonly PermissionRequest[];
  bottomInset: number;
  onDecide: (
    request: PermissionRequest,
    decision: PermissionDecision,
  ) => void | Promise<void>;
  /**
   * Deny the request and hand the agent free-text guidance to try next. Empty
   * text falls back to a plain Deny.
   */
  onDenyWithMessage: (
    request: PermissionRequest,
    message: string,
  ) => void | Promise<void>;
}) {
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [denyText, setDenyText] = useState("");
  const request = requests[0];

  if (!request) return null;

  const { detail, mono } = describePermissionKind(request.kind);
  const question = permissionQuestion(request.kind);
  const countLabel = requests.length > 1 ? ` +${requests.length - 1}` : "";
  const busy = decidingId !== null;

  const run = async (task: () => void | Promise<void>) => {
    if (busy) return;
    setDecidingId(request.id);
    try {
      await task();
    } finally {
      setDecidingId(null);
      setDenyText("");
    }
  };

  const decide = (decision: PermissionDecision) =>
    void run(() => onDecide(request, decision));

  const deny = () => {
    const message = denyText.trim();
    void run(() =>
      message.length > 0
        ? onDenyWithMessage(request, message)
        : onDecide(request, { _tag: "Deny" }),
    );
  };

  return (
    <View
      pointerEvents="box-none"
      style={{ paddingBottom: Math.max(bottomInset, 8) }}
      className="px-3 pt-2"
    >
      <GlassSurface
        style={{
          paddingHorizontal: 14,
          paddingVertical: 14,
          gap: 12,
        }}
      >
        <Text className="font-sans-medium text-[12px] uppercase text-primary">
          Permission{countLabel}
        </Text>
        <Text className="font-sans-bold text-[16px] leading-5 text-foreground">
          {question}
        </Text>
        {mono ? (
          <View
            className="rounded-xl border border-border bg-card px-3 py-2"
            style={{ borderCurve: "continuous" }}
          >
            <Text
              selectable
              className="font-mono text-[12px] leading-5 text-foreground"
              numberOfLines={4}
            >
              {detail}
            </Text>
          </View>
        ) : (
          <Text
            className="font-sans text-[13px] leading-5 text-muted-foreground"
            numberOfLines={3}
          >
            {detail}
          </Text>
        )}
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => decide({ _tag: "AllowOnce" })}
          className="h-12 items-center justify-center rounded-full bg-foreground active:opacity-80"
          style={{ borderCurve: "continuous", opacity: busy ? 0.45 : 1 }}
        >
          <Text className="font-sans-medium text-[16px] text-background">
            Approve
          </Text>
        </Pressable>
        {request.forcePrompt ? null : (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => decide({ _tag: "AllowForSession" })}
            className="h-11 items-center justify-center rounded-full active:opacity-70"
          >
            <Text className="font-sans-medium text-[15px] text-muted-foreground">
              Always approve
            </Text>
          </Pressable>
        )}
        <View className="flex-row items-center gap-2">
          <TextInput
            className="h-11 min-w-0 flex-1 rounded-full bg-card px-4 font-sans text-[15px] text-foreground"
            placeholder="Tell the agent what to do"
            placeholderTextColor="hsl(72 4% 56%)"
            value={denyText}
            onChangeText={setDenyText}
            editable={!busy}
            style={{ borderCurve: "continuous" }}
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={deny}
            hitSlop={8}
            className="px-3 py-2 active:opacity-70"
          >
            <Text className="font-sans-medium text-[15px] text-danger">
              Deny
            </Text>
          </Pressable>
        </View>
      </GlassSurface>
    </View>
  );
}
