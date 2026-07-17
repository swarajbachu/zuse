import { HugeiconsIcon } from "@hugeicons/react";
import { CheckListIcon } from "@hugeicons-pro/core-bulk-rounded";

import type { SessionId } from "@zuse/contracts";
import { PLAN_APPROVAL_PROMPT } from "@zuse/utils/proposed-plan";
import { useEffect, useMemo, useState } from "react";

import {
  attachFileWhenReady,
  latestPlanText,
  saveContextFile,
} from "../../lib/context-handoff.ts";
import {
  findPendingNativePlanApproval,
  selectPlanApprovalMessages,
} from "../../lib/plan-feedback-routing.ts";
import { useComposerBridge } from "../../store/composer-bridge.ts";
import { useMessagesStore } from "../../store/messages.ts";
import { usePermissionsStore } from "../../store/permissions.ts";
import { useSessionsStore } from "../../store/sessions.ts";
import { toastManager } from "../ui/toast.tsx";
import { TrayPill } from "./tray-pill.tsx";

export const EMULATED_PLAN_APPROVAL_PROMPT = PLAN_APPROVAL_PROMPT;

/**
 * Pinned "Review plan" bar docked above the composer. The proposed plan still
 * renders inline in the chat scrollback (see `ExitPlanModeRow`); this tray only
 * hoists the Approve / Cancel decision down to where the user's cursor already
 * sits, so they don't have to scroll back up to act. Renders nothing unless an
 * `ExitPlanMode` permission request is open for this session, or an emulated
 * plan-mode provider has produced an assistant plan and is waiting for the
 * user to continue.
 */
export function PlanApprovalTray({
  sessionId,
  emulatedPlanReady = false,
  onApproveEmulatedPlan,
  onCancelEmulatedPlan,
}: {
  sessionId: SessionId;
  emulatedPlanReady?: boolean;
  onApproveEmulatedPlan?: () => void;
  onCancelEmulatedPlan?: () => void;
}) {
  const pendingRequest = usePermissionsStore((s) => {
    for (const req of Object.values(s.requestsById)) {
      if (req.sessionId !== sessionId) continue;
      if (req.kind._tag !== "Other") continue;
      if (req.kind.tool !== "ExitPlanMode") continue;
      return req;
    }
    return null;
  });
  const decide = usePermissionsStore((s) => s.decide);
  const messages = useMessagesStore((s) =>
    selectPlanApprovalMessages(s.messagesBySession, sessionId),
  );
  const nativeRequest = useMemo(
    () =>
      pendingRequest === null ? findPendingNativePlanApproval(messages) : null,
    [messages, pendingRequest],
  );
  const respondToPlan = useSessionsStore((s) => s.respondToPlan);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setSubmitting(false);
  }, [nativeRequest?.toolCallId, pendingRequest?.id, emulatedPlanReady]);

  const respondNative = async (
    outcome: "approved" | "cancelled" | "abandoned",
  ) => {
    if (nativeRequest === null || submitting) return;
    setSubmitting(true);
    const accepted = await respondToPlan(
      sessionId,
      nativeRequest.toolCallId,
      outcome,
    );
    if (accepted !== "accepted") setSubmitting(false);
    queueMicrotask(() => useComposerBridge.getState().focus?.());
  };

  // Hand the proposed plan off to a fresh build-mode session in the same chat.
  // The current plan-mode session is left untouched (its ExitPlanMode prompt
  // stays open), so the user can keep iterating on the plan or discard it.
  const handoff = async () => {
    if (submitting) return;
    setSubmitting(true);
    const source = Object.values(useSessionsStore.getState().sessionsByProject)
      .flat()
      .find((row) => row.id === sessionId);
    const planText = latestPlanText(sessionId);
    if (source === undefined || planText === null) {
      setSubmitting(false);
      toastManager.add({
        title: "Nothing to hand off",
        description: "Could not find the proposed plan for this session.",
        type: "error",
      });
      return;
    }
    const created = await useSessionsStore
      .getState()
      .create(source.chatId, source.providerId, source.model, {
        permissionMode: "default",
        runtimeMode: source.runtimeMode,
      });
    if (created === null) {
      setSubmitting(false);
      toastManager.add({
        title: "Handoff failed",
        description: "Could not create the build session.",
        type: "error",
      });
      return;
    }
    const ref = await saveContextFile(created, planText);
    if (ref !== null) attachFileWhenReady(ref);
    if (pendingRequest !== null) {
      await decide(pendingRequest.id, { _tag: "Deny" });
      await useSessionsStore.getState().setPermissionMode(sessionId, "default");
    } else if (nativeRequest !== null) {
      await respondToPlan(sessionId, nativeRequest.toolCallId, "abandoned");
    } else {
      onCancelEmulatedPlan?.();
    }
    toastManager.add({
      title: "Plan handed off",
      description:
        ref !== null
          ? "New session opened in build mode with the plan attached."
          : "New session opened in build mode.",
      type: "success",
    });
  };

  if (pendingRequest === null && nativeRequest === null && !emulatedPlanReady)
    return null;
  const isPermissionBacked = pendingRequest !== null;

  return (
    <TrayPill
      flush
      className="bg-rose-500/10 hover:bg-rose-500/15"
      icon={
        <HugeiconsIcon
          icon={CheckListIcon}
          strokeWidth={2}
          className="size-3.5"
        />
      }
      title="Review plan"
      subtitle="Type feedback below, or approve the plan"
      actions={
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={() => void handoff()}
            disabled={submitting}
            title="Open a new session in build mode with this plan attached"
            className="rounded-md px-2.5 py-0.5 text-[12px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            Hand off →
          </button>
          <button
            type="button"
            onClick={() => {
              if (submitting) return;
              if (nativeRequest !== null) {
                void respondNative("abandoned");
                return;
              }
              if (pendingRequest !== null) {
                void decide(pendingRequest.id, { _tag: "Deny" });
                return;
              }
              onCancelEmulatedPlan?.();
            }}
            disabled={submitting}
            className="rounded-md px-2.5 py-0.5 text-[12px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            Abandon
          </button>
          <button
            type="button"
            onClick={() => {
              if (nativeRequest !== null) {
                void respondNative("approved");
                return;
              }
              if (pendingRequest !== null) {
                void decide(pendingRequest.id, { _tag: "AllowOnce" });
                return;
              }
              onApproveEmulatedPlan?.();
            }}
            disabled={
              submitting ||
              (nativeRequest === null &&
                !isPermissionBacked &&
                onApproveEmulatedPlan === undefined)
            }
            className="rounded-md bg-foreground px-2.5 py-0.5 text-[12px] font-medium text-background hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            Approve
          </button>
        </div>
      }
    />
  );
}
