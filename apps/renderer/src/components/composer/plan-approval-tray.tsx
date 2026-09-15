import "@zuse/i18n/english/chat";
import { HugeiconsIcon } from "@hugeicons/react";
import type { EnvironmentId, SessionId } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { CheckListIcon } from "@zuse/icons/solid-rounded";
import {
	latestProposedPlanMarkdown,
	PLAN_APPROVAL_PROMPT,
} from "@zuse/utils/proposed-plan";
import { useEffect, useMemo, useState } from "react";

import {
	attachFileWhenReady,
	saveContextFile,
} from "../../lib/context-handoff.ts";
import { useActiveSessionById } from "../../lib/environment-entity-hooks.ts";
import {
	decideEnvironmentPermission,
	useEnvironmentPermissions,
} from "../../lib/environment-permissions-client-bus.ts";
import { findPendingNativePlanApproval } from "../../lib/plan-feedback-routing.ts";
import { findPresentedPermissions } from "../../lib/question-actionability.ts";
import { useRendererSessionTimeline } from "../../lib/session-timeline-hooks.ts";
import { useComposerBridge } from "../../store/composer-bridge.ts";
import { useSessionsStore } from "../../store/sessions.ts";
import { toastManager } from "../ui/toast.tsx";
import { TrayPill } from "./tray-pill.tsx";

export const EMULATED_PLAN_APPROVAL_PROMPT = PLAN_APPROVAL_PROMPT;

const latestPlanTextFromMessages = (
	messages: ReturnType<typeof useRendererSessionTimeline>["messages"],
): string | null => latestProposedPlanMarkdown(messages);

export function PlanApprovalSubmissionStatus({
	submitting,
	error,
}: {
	readonly submitting: boolean;
	readonly error: string | null;
}) {
	if (error !== null) {
		return (
			<span role="alert" className="text-danger-text">
				Couldn’t submit plan decision: {error}
			</span>
		);
	}
	return submitting
		? "Submitting plan decision…"
		: "Type feedback below, or approve the plan";
}

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
	environmentId,
	emulatedPlanReady = false,
	onApproveEmulatedPlan,
	onCancelEmulatedPlan,
}: {
	sessionId: SessionId;
	environmentId: EnvironmentId;
	emulatedPlanReady?: boolean;
	onApproveEmulatedPlan?: () => void;
	onCancelEmulatedPlan?: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat"]);
	const timeline = useRendererSessionTimeline(
		sessionId,
		"connect",
		environmentId,
	);
	const permissionRequests =
		useEnvironmentPermissions(environmentId).data?.requestsById ?? {};
	const pendingRequest =
		findPresentedPermissions(
			timeline.presentation.interactions,
			permissionRequests,
		).find((item) => {
			const kind = item.interaction.request.kind;
			return (
				item.interaction.request.recoveryState !== "expired" &&
				kind._tag === "Other" &&
				kind.tool === "ExitPlanMode"
			);
		}) ?? null;
	const decide = (
		request: NonNullable<typeof pendingRequest>["interaction"]["request"],
		decision: Parameters<typeof decideEnvironmentPermission>[1],
	) => decideEnvironmentPermission(request, decision, environmentId);
	const messages = timeline.messages;
	const nativeRequest = useMemo(
		() =>
			pendingRequest === null ? findPendingNativePlanApproval(messages) : null,
		[messages, pendingRequest, uiMessage],
	);
	const respondToPlan = useSessionsStore((s) => s.respondToPlan);
	const sourceSession = useActiveSessionById(sessionId);
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		setSubmitting(false);
	}, [
		nativeRequest?.toolCallId,
		pendingRequest?.interaction.id,
		emulatedPlanReady,
	]);

	const respondNative = async (
		outcome: "approved" | "cancelled" | "abandoned",
	) => {
		if (nativeRequest === null || submitting) return;
		setSubmitting(true);
		const accepted = await respondToPlan(
			sessionId,
			nativeRequest.toolCallId,
			outcome,
			undefined,
			{ environmentId },
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
		const source = sourceSession;
		const planText = latestPlanTextFromMessages(messages);
		if (source === null || planText === null) {
			setSubmitting(false);
			toastManager.add({
				title: uiMessage("chat:plan_approval_tray_nothing_to_hand_off"),
				description: uiMessage(
					"chat:plan_approval_tray_could_not_find_the_proposed_plan_for_this_session",
				),
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
				title: uiMessage("chat:plan_approval_tray_handoff_failed"),
				description: uiMessage(
					"chat:plan_approval_tray_could_not_create_the_build_session",
				),
				type: "error",
			});
			return;
		}
		const ref = await saveContextFile(environmentId, created, planText);
		if (ref !== null) attachFileWhenReady(ref);
		if (pendingRequest !== null) {
			await decide(pendingRequest.interaction.request, { _tag: "Deny" });
			await useSessionsStore
				.getState()
				.setPermissionMode(sessionId, "default", environmentId);
		} else if (nativeRequest !== null) {
			await respondToPlan(
				sessionId,
				nativeRequest.toolCallId,
				"abandoned",
				undefined,
				{ environmentId },
			);
		} else {
			onCancelEmulatedPlan?.();
		}
		toastManager.add({
			title: uiMessage("chat:plan_approval_tray_plan_handed_off"),
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
	const permissionSubmitting = pendingRequest?.submission === "submitting";
	const interactionSubmitting = submitting || permissionSubmitting;
	const permissionError =
		pendingRequest?.submission === "failed" ? pendingRequest.error : null;

	return (
		<TrayPill
			flush
			className="bg-card/80 hover:bg-card"
			icon={
				<HugeiconsIcon
					icon={CheckListIcon}
					strokeWidth={2}
					className="size-3.5"
				/>
			}
			title={uiMessage("chat:plan_approval_tray_review_plan")}
			subtitle={
				<PlanApprovalSubmissionStatus
					submitting={permissionSubmitting}
					error={permissionError}
				/>
			}
			actions={
				<div className="flex items-center justify-end gap-1">
					<button
						type="button"
						onClick={() => void handoff()}
						disabled={interactionSubmitting}
						title={uiMessage(
							"chat:plan_approval_tray_open_a_new_session_in_build_mode_with_this_plan_attached",
						)}
						className="rounded-md px-2.5 py-0.5 text-[12px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
					>
						{uiMessage("chat:plan_approval_tray_hand_off")}
					</button>
					<button
						type="button"
						onClick={() => {
							if (interactionSubmitting) return;
							if (nativeRequest !== null) {
								void respondNative("abandoned");
								return;
							}
							if (pendingRequest !== null) {
								void decide(pendingRequest.interaction.request, {
									_tag: "Deny",
								});
								return;
							}
							onCancelEmulatedPlan?.();
						}}
						disabled={interactionSubmitting}
						className="rounded-md px-2.5 py-0.5 text-[12px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
					>
						{uiMessage("chat:plan_approval_tray_abandon")}
					</button>
					<button
						type="button"
						onClick={() => {
							if (nativeRequest !== null) {
								void respondNative("approved");
								return;
							}
							if (pendingRequest !== null) {
								void decide(pendingRequest.interaction.request, {
									_tag: "AllowOnce",
								});
								return;
							}
							onApproveEmulatedPlan?.();
						}}
						disabled={
							interactionSubmitting ||
							(nativeRequest === null &&
								!isPermissionBacked &&
								onApproveEmulatedPlan === undefined)
						}
						className="rounded-md bg-primary px-3 py-0.5 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
					>
						{uiMessage("chat:plan_approval_tray_approve")}
					</button>
				</div>
			}
		/>
	);
}
