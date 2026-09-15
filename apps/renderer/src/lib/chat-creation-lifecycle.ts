import type { ChatCreationPhase, WorktreeSetupStatus } from "@zuse/contracts";

/**
 * Whether a durable chat creation still has work left to perform.
 *
 * Failed and cancelled operations remain visible so the user can retry or
 * dismiss them, but they must never keep renderer surfaces loading.
 */
export const chatCreationIsInProgress = (phase: ChatCreationPhase): boolean =>
	phase === "persisted" ||
	phase === "creating_workspace" ||
	phase === "running_setup" ||
	phase === "starting_agent" ||
	phase === "cancelling";

export const worktreeSetupIsActive = (
	status: WorktreeSetupStatus | null,
): boolean => status === "pending" || status === "running";
