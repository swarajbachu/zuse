import { pbkdf2Sync } from "node:crypto";
import { join } from "node:path";

export interface BrowserCookieHostAdapter {
	readonly profileSearchRoots: ReadonlyArray<string>;
	readonly validateInstalledApplications: boolean;
	readonly defaultBrowserCommand: {
		readonly executable: string;
		readonly args: ReadonlyArray<string>;
	} | null;
	readonly normalizeDefaultBrowserId: (value: string) => string;
	readonly decryptionKeys: (password: string | null) => ReadonlyArray<Buffer>;
}

const unique = (values: ReadonlyArray<string>): ReadonlyArray<string> => [
	...new Set(values),
];

const deriveKey = (password: string, iterations: number): Buffer =>
	pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");

const linuxProfileRoots = (
	home: string,
	env: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> => {
	const config = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
	return unique([
		config,
		join(home, "snap", "chromium", "common", "chromium"),
		join(home, "snap", "brave", "common", "brave"),
		join(home, ".var", "app", "com.google.Chrome", "config"),
		join(home, ".var", "app", "org.chromium.Chromium", "config"),
		join(home, ".var", "app", "com.brave.Browser", "config"),
		join(home, ".var", "app", "com.microsoft.Edge", "config"),
		join(home, ".var", "app", "com.vivaldi.Vivaldi", "config"),
	]);
};

export const createBrowserCookieHostAdapter = (input: {
	readonly platform: NodeJS.Platform;
	readonly home: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
}): BrowserCookieHostAdapter => {
	if (input.platform === "darwin") {
		return {
			profileSearchRoots: [join(input.home, "Library", "Application Support")],
			validateInstalledApplications: true,
			defaultBrowserCommand: {
				executable: "defaults",
				args: [
					"read",
					"com.apple.LaunchServices/com.apple.launchservices.secure",
					"LSHandlers",
				],
			},
			normalizeDefaultBrowserId: (value) => value.trim(),
			decryptionKeys: (password) =>
				password === null ? [] : [deriveKey(password, 1003)],
		};
	}
	if (input.platform === "linux") {
		return {
			profileSearchRoots: linuxProfileRoots(input.home, input.env ?? {}),
			validateInstalledApplications: false,
			defaultBrowserCommand: {
				executable: "xdg-settings",
				args: ["get", "default-web-browser"],
			},
			normalizeDefaultBrowserId: (value) =>
				value
					.trim()
					.replace(/\.desktop$/iu, "")
					.replaceAll("-", " "),
			decryptionKeys: (password) =>
				unique(
					[password, "peanuts"].filter(
						(value): value is string => value !== null,
					),
				).map((value) => deriveKey(value, 1)),
		};
	}
	return {
		profileSearchRoots: [],
		validateInstalledApplications: false,
		defaultBrowserCommand: null,
		normalizeDefaultBrowserId: (value) => value.trim(),
		decryptionKeys: () => [],
	};
};
