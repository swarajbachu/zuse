/**
 * When this desktop copy registers itself with the account as a computer.
 *
 * Automatic registration on startup is off until it is redesigned: every copy
 * on a machine shares one sign-in but has its own computer identity, so
 * registering on startup put the same machine in the account once per copy.
 * Registering from Settings → Devices still works, and
 * `ZUSE_DESKTOP_AUTO_LINK=1` restores startup registration for testing.
 *
 * Only the installed app keeps a saved registration alive. Development copies
 * get a fresh identity per worktree and port, so a copy that may not publish
 * removes any registration it made before instead of leaving one offline
 * computer in the account per dev run.
 */
export const desktopRemoteAccessPolicy = (
	development: boolean,
	env: Readonly<Record<string, string | undefined>> = process.env,
): {
	readonly autoLink: boolean;
	readonly resumeLink: boolean;
	readonly retireLink: boolean;
} => {
	const mayPublish = !development || env.ZUSE_DEV_REMOTE_ACCESS === "1";
	return {
		autoLink: mayPublish && env.ZUSE_DESKTOP_AUTO_LINK === "1",
		resumeLink: mayPublish,
		retireLink: !mayPublish,
	};
};
