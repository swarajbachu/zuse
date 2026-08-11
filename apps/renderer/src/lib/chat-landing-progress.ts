export type ChatLandingProgress =
	| { readonly kind: "cloud"; readonly status: string }
	| { readonly kind: "worktree" }
	| { readonly kind: "none" };

export const chatLandingProgress = (input: {
	readonly cloudStatus: string | null;
	readonly hasPendingWorktree: boolean;
}): ChatLandingProgress => {
	if (input.cloudStatus !== null)
		return { kind: "cloud", status: input.cloudStatus };
	if (input.hasPendingWorktree) return { kind: "worktree" };
	return { kind: "none" };
};
