const SNAPSHOT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Provider-neutral snapshot name: lowercase, hyphenated, `zuse-` prefixed, at most 63 characters. */
export const zuseSnapshotName = (name: string): string => {
	const sanitized = `zuse-${name.toLowerCase().replaceAll(/[^a-z0-9-]/gu, "-")}`
		.replaceAll(/-{2,}/gu, "-")
		.slice(0, 63)
		.replace(/-+$/u, "");
	return SNAPSHOT_NAME_PATTERN.test(sanitized) ? sanitized : "";
};
