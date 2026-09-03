import type { ChatCreationPhase, Worktree } from "@zuse/contracts";

export type SetupCardVisibilityInput = {
	readonly externalResume: boolean;
	readonly initialSession: boolean;
	readonly hasWorktree: boolean;
	readonly setupDone: boolean;
	readonly workspacePending?: boolean;
};

export const workspaceCreationProgressIsActive = (input: {
	readonly workspaceRequested: boolean;
	readonly setupStatus: Worktree["setupStatus"] | null;
	readonly creationPhase: ChatCreationPhase | null;
}): boolean =>
	input.workspaceRequested &&
	input.setupStatus !== "succeeded" &&
	input.setupStatus !== "skipped" &&
	input.creationPhase !== "starting_agent" &&
	input.creationPhase !== "running";

export const shouldShowSetupCard = ({
	externalResume,
	initialSession,
	hasWorktree,
	setupDone,
	workspacePending = false,
}: SetupCardVisibilityInput): boolean =>
	initialSession &&
	!setupDone &&
	(workspacePending || (!externalResume && hasWorktree));
