import type { NpmToolSpec } from "../process/npm-tool-installer.ts";
export const SIMULATOR_TOOLS = {
	hub: {
		name: "expo-device-hub",
		version: "0.15.3",
		entry: ["dist", "server", "cli.mjs"],
	},
	agent: {
		name: "agent-device",
		version: "0.21.23",
		entry: ["bin", "agent-device.mjs"],
	},
} satisfies Record<string, NpmToolSpec>;
export function supportedDeviceNode(version: string): boolean {
	const [major = 0, minor = 0] = version
		.replace(/^v/, "")
		.split(".")
		.map(Number);
	return major > 22 || (major === 22 && minor >= 12);
}

/**
 * Android SDK Command-line Tools (latest), pinned like the npm helpers. Values
 * come from Google's `repository2-3.xml`; the download is verified before use.
 */
export const ANDROID_CMDLINE_TOOLS = {
	revision: "23.0",
	base: "https://dl.google.com/android/repository/",
	archives: {
		"linux-x64": {
			file: "commandlinetools-linux-16111833_latest.zip",
			sha1: "e025545c62a8e64c7559119566a569fb1dec5f60",
		},
		"linux-arm64": {
			file: "commandlinetools-linux-16111833_latest.zip",
			sha1: "e025545c62a8e64c7559119566a569fb1dec5f60",
		},
		"darwin-x64": {
			file: "commandlinetools-mac_x86_64-16111833_latest.zip",
			sha1: "112cf9618794a997ff273537d55bee02c22abffe",
		},
		"darwin-arm64": {
			file: "commandlinetools-mac_arm64-16111833_latest.zip",
			sha1: "ad03dc49bfacfd52c110b14104ea548b8a07e830",
		},
	} as Record<string, { file: string; sha1: string } | undefined>,
} as const;

/** The emulator created by the one-click "Create" fix. */
export const ANDROID_DEFAULT_AVD = {
	name: "Zuse_Pixel_API_35",
	device: "pixel_8",
	image: (arch: string) =>
		`system-images;android-35;google_apis;${arch === "arm64" ? "arm64-v8a" : "x86_64"}`,
} as const;
