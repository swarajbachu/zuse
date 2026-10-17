export type ShellPlatform = string;

export interface ShellCommand {
	readonly command: string;
	readonly args: ReadonlyArray<string>;
}

/**
 * Resolve the native command processor used for project-authored scripts.
 * Keep this shared because setup, run, and archive scripts must all use the
 * same quoting and platform semantics.
 */
export const shellCommandForPlatform = (
	platform: ShellPlatform,
	env: Readonly<Record<string, string | undefined>> = {},
): ShellCommand => {
	if (platform === "win32") {
		return {
			command: env.COMSPEC?.trim() || "cmd.exe",
			args: ["/d", "/s", "/c"],
		};
	}
	return {
		command:
			env.SHELL?.trim() || (platform === "darwin" ? "/bin/zsh" : "/bin/sh"),
		args: ["-lc"],
	};
};

export const scriptCommandForPlatform = (
	platform: ShellPlatform,
	script: string,
	env: Readonly<Record<string, string | undefined>> = {},
): ShellCommand => {
	const shell = shellCommandForPlatform(platform, env);
	return { command: shell.command, args: [...shell.args, script] };
};
