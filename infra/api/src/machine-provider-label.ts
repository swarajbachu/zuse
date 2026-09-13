export const machineProviderLabel = (machineId: string): string =>
	`zuse-${machineId}`
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 63)
		.replace(/-$/, "");
