export interface CloudWorkspaceAccessPresentation {
	readonly subscribed: boolean;
	readonly serviceError: string | null;
}

export const cloudWorkspaceAccessPresentation = (input: {
	readonly entitlementSubscribed: boolean;
	readonly serviceAvailable: boolean;
}): CloudWorkspaceAccessPresentation => {
	const subscribed = input.entitlementSubscribed;
	return {
		subscribed,
		serviceError: input.serviceAvailable
			? null
			: subscribed
				? "Your subscription is active. Cloud workspace controls require the api update."
				: "Cloud workspace services are temporarily unavailable.",
	};
};
