import type { PermissionDecision, PermissionRequest } from "@zuse/contracts";
import { useState } from "react";
import { Text, View } from "react-native";

import { Button } from "~/components/ui/button";
import { describePermissionKind } from "~/lib/permission-presentation";

/**
 * Inline card for a pending tool-permission prompt. `forcePrompt` requests
 * hide "Allow session" so the user can't silence future prompts by accident
 * — mirroring the renderer. That flag is used for sensitive paths, plan
 * mode, and a few always-prompt tools; it is not only "sensitive path".
 */
export const PendingApprovalCard = ({
  request,
  onDecide
}: {
  request: PermissionRequest;
  onDecide: (decision: PermissionDecision) => void | Promise<void>;
}) => {
  const [deciding, setDeciding] = useState(false);
  const { label, detail, mono } = describePermissionKind(request.kind);

  const decide = async (decision: PermissionDecision) => {
    if (deciding) return;
    setDeciding(true);
    try {
      await onDecide(decision);
    } finally {
      setDeciding(false);
    }
  };

  return (
    <View className="px-3 py-1.5">
      <View
        style={{ borderCurve: "continuous" }}
        className="rounded-2xl border border-primary/40 bg-card px-3 py-3"
      >
        <Text className="font-sans-medium text-xs text-primary">Permission required</Text>
        <Text className="mt-1 font-sans-medium text-sm text-foreground">{label}</Text>
        <Text
          className={mono ? "mt-1 font-mono text-xs leading-5 text-muted-foreground" : "mt-1 font-sans text-sm leading-5 text-muted-foreground"}
          numberOfLines={6}
        >
          {detail}
        </Text>
        <View className="mt-3 flex-row flex-wrap gap-2">
          <Button size="sm" disabled={deciding} onPress={() => decide({ _tag: "AllowOnce" })}>
            Allow once
          </Button>
          {request.forcePrompt ? null : (
            <Button
              size="sm"
              variant="secondary"
              disabled={deciding}
              onPress={() => decide({ _tag: "AllowForSession" })}
            >
              Allow session
            </Button>
          )}
          <Button size="sm" variant="danger" disabled={deciding} onPress={() => decide({ _tag: "Deny" })}>
            Decline
          </Button>
        </View>
      </View>
    </View>
  );
};
