export type SetupCardVisibilityInput = {
	readonly externalResume: boolean;
	readonly initialSession: boolean;
	readonly hasWorktree: boolean;
	readonly setupDone: boolean;
	readonly providerBooting: boolean;
};

export const shouldShowSetupCard = ({
	externalResume,
	initialSession,
	hasWorktree,
	setupDone,
	providerBooting,
}: SetupCardVisibilityInput): boolean =>
	!externalResume &&
	initialSession &&
	((hasWorktree && (!setupDone || providerBooting)) ||
		(!hasWorktree && providerBooting));
