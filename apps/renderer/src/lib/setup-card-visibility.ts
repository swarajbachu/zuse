export type SetupCardVisibilityInput = {
	readonly externalResume: boolean;
	readonly initialSession: boolean;
	readonly hasWorktree: boolean;
	readonly setupDone: boolean;
};

export const shouldShowSetupCard = ({
	externalResume,
	initialSession,
	hasWorktree,
	setupDone,
}: SetupCardVisibilityInput): boolean =>
	!externalResume && initialSession && hasWorktree && !setupDone;
