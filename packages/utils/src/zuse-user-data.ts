import { join, win32 } from "node:path";

export const zuseDesktopProfileName = (development: boolean): string =>
	development ? "Zuse Alpha (Dev)" : "Zuse Alpha";

export const resolveZuseDesktopUserData = (input: {
	readonly platform: NodeJS.Platform;
	readonly homeDir: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly development: boolean;
}): string => {
	const profileName = zuseDesktopProfileName(input.development);
	if (input.platform === "darwin") {
		return join(input.homeDir, "Library", "Application Support", profileName);
	}
	if (input.platform === "win32") {
		return win32.join(
			input.env.APPDATA?.trim() ||
				win32.join(input.homeDir, "AppData", "Roaming"),
			profileName,
		);
	}
	const config =
		input.env.XDG_CONFIG_HOME?.trim() || join(input.homeDir, ".config");
	return join(config, profileName);
};
