import type { PermissionDecision, PermissionRequest } from "@zuse/wire";
import { ShieldCheck } from "lucide-react-native";
import { useState } from "react";
import { Text, View } from "react-native";

import { Button } from "~/components/ui/button";
import { GlassSurface } from "~/components/ui/glass-surface";
import { describePermissionKind } from "~/lib/permission-presentation";

const ACCENT = "hsl(72 98% 54%)";

export function LivePermissionAccessory({
  requests,
  bottomInset,
  onDecide,
}: {
  requests: readonly PermissionRequest[];
  bottomInset: number;
  onDecide: (
    request: PermissionRequest,
    decision: PermissionDecision,
  ) => void | Promise<void>;
}) {
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const request = requests[0];

  if (!request) return null;

  const { label, detail, mono } = describePermissionKind(request.kind);
  const countLabel = requests.length > 1 ? ` +${requests.length - 1}` : "";

  const decide = async (decision: PermissionDecision) => {
    if (decidingId !== null) return;
    setDecidingId(request.id);
    try {
      await onDecide(request, decision);
    } finally {
      setDecidingId(null);
    }
  };

  return (
    <View
      pointerEvents="box-none"
      style={{ paddingBottom: Math.max(bottomInset, 8) }}
      className="px-3 pt-2"
    >
      <GlassSurface
        style={{
          minHeight: 104,
          paddingHorizontal: 12,
          paddingVertical: 12,
        }}
      >
        <View className="flex-row gap-3">
          <View className="mt-0.5 h-9 w-9 items-center justify-center rounded-full bg-primary/15">
            <ShieldCheck size={18} color={ACCENT} />
          </View>
          <View className="min-w-0 flex-1">
            <View className="flex-row items-center gap-2">
              <Text className="font-sans-medium text-[12px] uppercase text-primary">
                Permission{countLabel}
              </Text>
              <Text className="font-sans text-[12px] text-muted-foreground">
                live
              </Text>
            </View>
            <Text
              className="mt-0.5 font-sans-medium text-[15px] text-foreground"
              numberOfLines={1}
            >
              {label}
            </Text>
            <Text
              className={
                mono
                  ? "mt-0.5 font-mono text-[12px] leading-5 text-muted-foreground"
                  : "mt-0.5 font-sans text-[13px] leading-5 text-muted-foreground"
              }
              numberOfLines={2}
            >
              {detail}
            </Text>
          </View>
        </View>
        <View className="mt-3 flex-row flex-wrap gap-2 pl-12">
          <Button
            size="sm"
            disabled={decidingId !== null}
            onPress={() => void decide({ _tag: "AllowOnce" })}
          >
            Allow once
          </Button>
          {request.forcePrompt ? null : (
            <Button
              size="sm"
              variant="secondary"
              disabled={decidingId !== null}
              onPress={() => void decide({ _tag: "AllowForSession" })}
            >
              Allow session
            </Button>
          )}
          <Button
            size="sm"
            variant="danger"
            disabled={decidingId !== null}
            onPress={() => void decide({ _tag: "Deny" })}
          >
            Decline
          </Button>
        </View>
      </GlassSurface>
    </View>
  );
}
