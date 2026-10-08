/**
 * Only the installed app publishes this computer by default. Development
 * copies get a fresh identity per worktree and port, so a copy that may not
 * publish also removes any registration it made before, instead of leaving one
 * offline "computer" in the account per dev run.
 */
export const desktopRemoteAccessPolicy = (
	development: boolean,
	env: Readonly<Record<string, string | undefined>> = process.env,
): {
	readonly autoLink: boolean;
	readonly resumeLink: boolean;
	readonly retireLink: boolean;
} => {
	const enabled = !development || env.ZUSE_DEV_REMOTE_ACCESS === "1";
	return { autoLink: enabled, resumeLink: enabled, retireLink: !enabled };
};
