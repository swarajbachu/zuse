import { CheckListIcon } from "@hugeicons-pro/core-bulk-rounded";
import { HugeiconsIcon } from "@hugeicons/react";

import type { SessionId } from "@zuse/wire";

import {
  attachFileWhenReady,
  latestPlanText,
  saveContextFile,
} from "../../lib/context-handoff.ts";
import { useChatsStore } from "../../store/chats.ts";
import { usePermissionsStore } from "../../store/permissions.ts";
import { useSessionsStore } from "../../store/sessions.ts";
import { toastManager } from "../ui/toast.tsx";
import { TrayPill } from "./tray-pill.tsx";

export const EMULATED_PLAN_APPROVAL_PROMPT =
  "Implement the proposed plan now. Make the code changes.";

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

  // Hand the proposed plan off to a fresh chat that starts in build mode. The
  // current plan-mode session is left untouched (its ExitPlanMode prompt stays
  // open), so the user can keep iterating on the plan or discard it.
  const handoff = async () => {
    const source = Object.values(
      useSessionsStore.getState().sessionsByProject,
    )
      .flat()
      .find((row) => row.id === sessionId);
    const planText = latestPlanText(sessionId);
    if (source === undefined || planText === null) {
      toastManager.add({
        title: "Nothing to hand off",
        description: "Could not find the proposed plan for this session.",
        type: "error",
      });
      return;
    }
    const created = await useChatsStore
      .getState()
      .create(source.projectId, source.providerId, source.model, {
        title: `Build: ${source.title}`,
        permissionMode: "default",
        // Fresh chat in the project's main checkout — the handoff is a new
        // conversation, not a continuation of the plan session's worktree.
        worktreeId: null,
      });
    if (created === null) {
      toastManager.add({
        title: "Handoff failed",
        description: "Could not create the build chat.",
        type: "error",
      });
      return;
    }
    const ref = await saveContextFile(created.initialSessionId, planText);
    if (ref !== null) attachFileWhenReady(ref);
    toastManager.add({
      title: "Plan handed off",
      description:
        ref !== null
          ? "New chat opened in build mode with the plan attached."
          : "New chat opened in build mode.",
      type: "success",
    });
  };

  if (pendingRequest === null && !emulatedPlanReady) return null;
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
      subtitle="Approve to start building"
      actions={
        <>
          <button
            type="button"
            onClick={() => void handoff()}
            title="Open a new chat in build mode with this plan attached"
            className="rounded-md px-2.5 py-0.5 text-[12px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            Hand off →
          </button>
          <button
            type="button"
            onClick={() => {
              if (pendingRequest !== null) {
                void decide(pendingRequest.id, { _tag: "Deny" });
                return;
              }
              onCancelEmulatedPlan?.();
            }}
            className="rounded-md px-2.5 py-0.5 text-[12px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (pendingRequest !== null) {
                void decide(pendingRequest.id, { _tag: "AllowOnce" });
                return;
              }
              onApproveEmulatedPlan?.();
            }}
            disabled={
              !isPermissionBacked && onApproveEmulatedPlan === undefined
            }
            className="rounded-md bg-foreground px-2.5 py-0.5 text-[12px] font-medium text-background hover:opacity-90"
          >
            Approve
          </button>
        </>
      }
    />
  );
}
