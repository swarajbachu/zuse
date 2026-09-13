/** Keep unfinished surfaces unavailable until device validation is complete. */
export const mobileReleaseFeatures = {
	terminal: false,
	voice: false,
	usage: false,
} as const;
