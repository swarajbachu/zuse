/** Keep unfinished surfaces unavailable until device validation is complete. */
export const mobileReleaseFeatures = {
	organizationWorkspaces:
		process.env.EXPO_PUBLIC_ORGANIZATION_WORKSPACES === "true",
	terminal: false,
	voice: false,
	usage: false,
} as const;
