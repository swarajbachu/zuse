/** The renderer-owned steps of a cloud launch, in order. Sandbox boot phases
 * between "starting" and "preparing" come from the workspace summary. */
export type CloudLaunchStep = "creating" | "starting" | "preparing" | "sending";

export type ChatLandingProgress =
	| { readonly kind: "cloud"; readonly step: CloudLaunchStep }
	| { readonly kind: "worktree" }
	| { readonly kind: "none" };

export const chatLandingProgress = (input: {
	readonly cloudStep: CloudLaunchStep | null;
	readonly hasPendingWorktree: boolean;
}): ChatLandingProgress => {
	if (input.cloudStep !== null) return { kind: "cloud", step: input.cloudStep };
	if (input.hasPendingWorktree) return { kind: "worktree" };
	return { kind: "none" };
};

/** What the queued first message is actually waiting on. Sandbox-owned
 * steps defer to the durable lifecycle label so it advances with the boot. */
export const cloudLaunchStepLabel = (
	step: CloudLaunchStep,
	lifecycleLabel: string,
): string => {
	switch (step) {
		case "creating":
		case "starting":
			return lifecycleLabel;
		case "preparing":
			return "Copying files to the sandbox…";
		case "sending":
			return "Sending message…";
	}
};
