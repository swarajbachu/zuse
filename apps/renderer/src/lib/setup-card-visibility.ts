export type SetupCardVisibilityInput = {
	readonly externalResume: boolean;
	readonly hasWorktree: boolean;
	readonly setupDone: boolean;
	readonly providerBooting: boolean;
};

export const shouldShowSetupCard = ({
	externalResume,
	hasWorktree,
	setupDone,
}: SetupCardVisibilityInput): boolean =>
	!externalResume && hasWorktree && !setupDone;
