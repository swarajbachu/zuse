/** Only the installed app publishes this computer by default. */
export const desktopRemoteAccessPolicy = (
	development: boolean,
	env: Readonly<Record<string, string | undefined>> = process.env,
): { readonly autoLink: boolean; readonly resumeLink: boolean } => {
	const enabled = !development || env.ZUSE_DEV_REMOTE_ACCESS === "1";
	return { autoLink: enabled, resumeLink: enabled };
};
