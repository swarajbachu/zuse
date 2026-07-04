import { CheckListIcon } from "@hugeicons-pro/core-bulk-rounded";
import { HugeiconsIcon } from "@hugeicons/react";

import { ComposerInput, type SessionId } from "@zuse/wire";

import {
  annotationsForSession,
  useAnnotationsStore,
} from "../../store/annotations.ts";
import { useMessagesStore } from "../../store/messages.ts";
import { usePermissionsStore } from "../../store/permissions.ts";
import { TrayPill } from "./tray-pill.tsx";

export const EMULATED_PLAN_APPROVAL_PROMPT =
  "Implement the proposed plan now. Make the code changes.";

/**
 * Pinned "Review plan" bar docked above the composer. The proposed plan still
 * renders inline in the chat scrollback (see `ExitPlanModeRow`); this tray
 * hoists the Approve / Cancel decision down to where the user's cursor already
 * sits. If the user left annotations on the plan, the decision also DELIVERS
 * them: they're sent as a message (so they land in the chat and reach the
 * agent) before the plan is approved or cancelled. Renders nothing unless an
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
  const send = useMessagesStore((s) => s.send);
  const annCount = useAnnotationsStore(
    (s) => (s.bySession[sessionId] ?? []).length,
  );

  if (pendingRequest === null && !emulatedPlanReady) return null;
  const isPermissionBacked = pendingRequest !== null;

  // Drain any pending annotations into a message so the user's comments land in
  // the chat and reach the agent. Fire it before the decision so the feedback
  // is registered alongside the plan response.
  const flushAnnotations = () => {
    const annotations = annotationsForSession(sessionId);
    if (annotations.length === 0) return;
    useAnnotationsStore.getState().clear(sessionId);
    void send(
      sessionId,
      ComposerInput.make({
        text: "",
        attachments: [],
        fileRefs: [],
        skillRefs: [],
        annotations,
      }),
    );
  };

  // Flush pending annotations, then apply the decision — either resolving the
  // real `ExitPlanMode` permission or, for emulated plan-mode providers,
  // handing off to the provided callback.
  const decideWith = (decision: "AllowOnce" | "Deny") => {
    flushAnnotations();
    if (pendingRequest !== null) {
      void decide(pendingRequest.id, { _tag: decision });
      return;
    }
    if (decision === "AllowOnce") onApproveEmulatedPlan?.();
    else onCancelEmulatedPlan?.();
  };

  const hasComments = annCount > 0;

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
      subtitle={
        hasComments
          ? `${annCount} comment${annCount > 1 ? "s" : ""} will be sent`
          : "Approve to start building"
      }
      actions={
        <>
          <button
            type="button"
            onClick={() => decideWith("Deny")}
            className="rounded-md px-2.5 py-0.5 text-[12px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            {hasComments ? "Send & cancel" : "Cancel"}
          </button>
          <button
            type="button"
            onClick={() => decideWith("AllowOnce")}
            disabled={
              !isPermissionBacked && onApproveEmulatedPlan === undefined
            }
            className="rounded-md bg-foreground px-2.5 py-0.5 text-[12px] font-medium text-background hover:opacity-90"
          >
            {hasComments ? "Send & approve" : "Approve"}
          </button>
        </>
      }
    />
  );
}
