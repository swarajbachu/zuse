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

export const cloudWorkspaceFailureMessage = (statusCode: string): string => {
	switch (statusCode) {
		case "network-policy-rejected":
			return "Cloud Sandbox could not apply its network policy. Try again after the provider configuration is fixed.";
		case "provider-sandbox-missing":
			return "The cloud sandbox no longer exists. Start a new cloud workspace.";
		case "provider-unavailable":
			return "The cloud provider stayed unavailable for five minutes. Try again.";
		case "setup-failed":
			return "Repository setup failed inside the cloud sandbox. Check the project setup command and prepare again.";
		default:
			return `Cloud workspace setup failed (${statusCode}).`;
	}
};
