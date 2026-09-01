export type SetupCardVisibilityInput = {
	readonly externalResume: boolean;
	readonly initialSession: boolean;
	readonly hasWorktree: boolean;
	readonly setupDone: boolean;
	readonly workspacePending?: boolean;
	readonly creationPending?: boolean;
};

export const shouldShowSetupCard = ({
	externalResume,
	initialSession,
	hasWorktree,
	setupDone,
	workspacePending = false,
	creationPending = false,
}: SetupCardVisibilityInput): boolean =>
	initialSession &&
	(workspacePending ||
		creationPending ||
		(!externalResume && hasWorktree && !setupDone));
