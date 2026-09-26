import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
	BUILTIN_PROVIDER_IDS,
	ExtensionManifest,
	type ExtensionSource,
} from "@zuse/contracts";
import { ZUSE_EXTENSION_API_VERSION } from "@zuse/extension-sdk";
import { Schema } from "effect";
import { satisfies, validRange } from "semver";

export const MANIFEST_FILENAME = "zuse-extension.json";
export const RESERVED_PROVIDER_IDS = new Set<string>(BUILTIN_PROVIDER_IDS);

export const readExtensionManifest = async (
	directory: string,
): Promise<typeof ExtensionManifest.Type> => {
	const manifestPath = join(directory, MANIFEST_FILENAME);
	const info = await stat(manifestPath).catch(() => null);
	if (!info?.isFile()) {
		throw new Error(`Extension manifest is missing: ${manifestPath}`);
	}
	const manifest = Schema.decodeUnknownSync(ExtensionManifest)(
		JSON.parse(await readFile(manifestPath, "utf8")),
	);
	if (!manifest.entry && !manifest.client && !manifest.server)
		throw new Error("Extension requires a client or server entry.");
	for (const value of [manifest.entry, manifest.client, manifest.server]) {
		if (!value) continue;
		const entry = normalize(value);
		if (
			isAbsolute(entry) ||
			entry === ".." ||
			entry.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
		) {
			throw new Error("Extension entry must stay inside its source directory.");
		}
		const entryPath = resolve(directory, entry);
		if (relative(resolve(directory), entryPath).startsWith("..")) {
			throw new Error("Extension entry must stay inside its source directory.");
		}
		if (!(await stat(entryPath).catch(() => null))?.isFile()) {
			throw new Error(`Extension entry is missing: ${entryPath}`);
		}
		const actual = relative(
			await realpath(directory),
			await realpath(entryPath),
		);
		if (actual === ".." || actual.startsWith(`..${sep}`) || isAbsolute(actual))
			throw new Error("Extension entry resolves outside its source directory.");
	}
	return manifest;
};

export const sourceDirectory = (source: ExtensionSource): string => {
	if (source._tag !== "directory") {
		throw new Error(`Source ${source._tag} is not a directory source.`);
	}
	return resolve(source.path);
};

export const assertApiCompatible = (range: string): void => {
	if (!validRange(range) || !satisfies(ZUSE_EXTENSION_API_VERSION, range)) {
		throw new Error(
			`Extension requires Zuse extension API ${range}; this build supports ${ZUSE_EXTENSION_API_VERSION}.`,
		);
	}
};

export const compileEntries = (
	directory: string,
	manifest: typeof ExtensionManifest.Type,
) => ({
	...(manifest.entry ? { entry: join(directory, manifest.entry) } : {}),
	...(manifest.client ? { client: join(directory, manifest.client) } : {}),
	...(manifest.server ? { server: join(directory, manifest.server) } : {}),
});
