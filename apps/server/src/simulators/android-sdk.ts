import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export interface AndroidSdk {
	/** Null when no SDK directory was found. */
	readonly root: string | null;
	readonly adb: boolean;
	readonly emulator: boolean;
	/** `cmdline-tools/latest`, which provides avdmanager and sdkmanager. */
	readonly cmdlineTools: boolean;
	/** The base SDK license has been accepted on this machine. */
	readonly licensed: boolean;
}

const exe = (name: string, platform: NodeJS.Platform) =>
	platform === "win32" ? `${name}.exe` : name;
const bat = (name: string, platform: NodeJS.Platform) =>
	platform === "win32" ? `${name}.bat` : name;
const exists = (path: string) =>
	access(path).then(
		() => true,
		() => false,
	);

export const androidTool = (
	root: string,
	tool: "adb" | "emulator" | "avdmanager" | "sdkmanager",
	platform: NodeJS.Platform = process.platform,
) =>
	tool === "adb"
		? join(root, "platform-tools", exe("adb", platform))
		: tool === "emulator"
			? join(root, "emulator", exe("emulator", platform))
			: join(root, "cmdline-tools", "latest", "bin", bat(tool, platform));

/** Default location used when the SDK has to be created. */
export const defaultAndroidSdkRoot = (
	platform: NodeJS.Platform = process.platform,
	home = homedir(),
	env: NodeJS.ProcessEnv = process.env,
) =>
	platform === "darwin"
		? join(home, "Library", "Android", "sdk")
		: platform === "win32"
			? join(
					env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
					"Android",
					"Sdk",
				)
			: join(home, "Android", "Sdk");

/** Finds the SDK from ANDROID_HOME, standard locations, then `adb` on PATH. */
export async function resolveAndroidSdk(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	home = homedir(),
): Promise<AndroidSdk> {
	const explicit = env.ANDROID_HOME?.trim() || env.ANDROID_SDK_ROOT?.trim();
	const candidates = explicit
		? [explicit]
		: [defaultAndroidSdkRoot(platform, home, env)];
	if (!explicit)
		for (const directory of (env.PATH ?? "").split(delimiter)) {
			if (!directory) continue;
			const adb = await realpath(join(directory, exe("adb", platform))).catch(
				() => null,
			);
			if (adb) candidates.push(dirname(dirname(adb)));
		}
	for (const root of candidates) {
		const [adb, emulator, cmdlineTools] = await Promise.all([
			exists(androidTool(root, "adb", platform)),
			exists(androidTool(root, "emulator", platform)),
			exists(androidTool(root, "avdmanager", platform)),
		]);
		if (explicit || adb || emulator || cmdlineTools)
			return {
				root,
				adb,
				emulator,
				cmdlineTools,
				licensed: await exists(join(root, "licenses", "android-sdk-license")),
			};
	}
	return {
		root: null,
		adb: false,
		emulator: false,
		cmdlineTools: false,
		licensed: false,
	};
}

/** Helpers find adb and the emulator through ANDROID_HOME and PATH. */
export function androidEnvironment(
	sdk: AndroidSdk,
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	if (!sdk.root) return { ...env };
	return {
		...env,
		ANDROID_HOME: sdk.root,
		ANDROID_SDK_ROOT: sdk.root,
		PATH: [
			join(sdk.root, "platform-tools"),
			join(sdk.root, "emulator"),
			join(sdk.root, "cmdline-tools", "latest", "bin"),
			env.PATH ?? "",
		].join(delimiter),
	};
}

/** AVD names from the user's AVD home, without starting any tool. */
export async function listAvdNames(
	env: NodeJS.ProcessEnv = process.env,
	home = homedir(),
): Promise<string[]> {
	const avdHome =
		env.ANDROID_AVD_HOME?.trim() ||
		join(env.ANDROID_USER_HOME?.trim() || join(home, ".android"), "avd");
	const entries = await readdir(avdHome).catch(() => []);
	return entries
		.filter((entry) => entry.endsWith(".ini"))
		.map((entry) => entry.slice(0, -4))
		.filter((name) => /^[A-Za-z0-9._-]{1,128}$/u.test(name))
		.sort();
}

/** "Pixel_8_API_35" reads better as "Pixel 8 API 35". */
export const androidDisplayName = (name: string) => name.replaceAll("_", " ");

/**
 * Downloads the pinned Command-line Tools archive, verifies its SHA-1, and
 * moves it into `cmdline-tools/latest`. An incomplete earlier copy is moved
 * aside rather than deleted.
 */
export async function installCmdlineTools(input: {
	root: string;
	url: string;
	sha1: string;
	signal: AbortSignal;
	unzip: (zip: string, into: string) => Promise<unknown>;
	onProgress: (percent: number) => void;
	fetch?: typeof fetch;
}) {
	const work = join(input.root, `.zuse-cmdline-tools-${randomUUID()}`);
	await mkdir(work, { recursive: true });
	try {
		const response = await (input.fetch ?? fetch)(input.url, {
			signal: input.signal,
		});
		if (!response.ok || !response.body)
			throw new Error(`download failed (${response.status})`);
		const total = Number(response.headers.get("content-length")) || 0;
		const zip = join(work, "tools.zip");
		const hash = createHash("sha1");
		const file = createWriteStream(zip);
		let received = 0;
		let reported = -1;
		try {
			for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
				hash.update(chunk);
				received += chunk.length;
				if (!file.write(chunk))
					await new Promise<void>((resolve) =>
						file.once("drain", () => resolve()),
					);
				const percent = total ? Math.floor((received / total) * 100) : 0;
				if (percent !== reported) {
					reported = percent;
					input.onProgress(percent);
				}
			}
		} finally {
			await new Promise<void>((resolve) => file.end(resolve));
		}
		if (hash.digest("hex") !== input.sha1)
			throw new Error("the download did not match its published checksum");
		await input.unzip(zip, work);
		const latest = join(input.root, "cmdline-tools", "latest");
		await mkdir(dirname(latest), { recursive: true });
		if (await exists(latest))
			await rename(latest, `${latest}.incomplete-${randomUUID()}`);
		await rename(join(work, "cmdline-tools"), latest);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}
