import { execFile } from "node:child_process";
import {
	access,
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { promisify } from "node:util";
import type { ExtensionManifest, ExtensionSource } from "@zuse/contracts";
import {
	decodeArtifact,
	fetchBounded,
	MAX_ARTIFACT_BYTES,
} from "./artifact.ts";
import type { MarketplaceCatalog } from "./marketplace.ts";
import { sha256 } from "./marketplace.ts";
import type { CompiledExtension } from "./types.ts";

const execute = promisify(execFile);

const assertNoNativeAddons = async (
	directory: string,
	rejectSymlinks: boolean,
): Promise<void> => {
	const pending = [directory];
	let inspected = 0;
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined) break;
		for (const entry of await readdir(current, { withFileTypes: true })) {
			inspected += 1;
			if (inspected > 100_000)
				throw new Error("Extension dependency tree is too large to validate.");
			if (entry.isSymbolicLink()) {
				if (rejectSymlinks)
					throw new Error(
						`Managed extension sources may not contain symbolic links (${entry.name}).`,
					);
				continue;
			}
			if (entry.isDirectory()) pending.push(join(current, entry.name));
			if (entry.isFile() && entry.name.endsWith(".node")) {
				throw new Error(
					`Extension packages may not ship native addons (${entry.name}).`,
				);
			}
		}
	}
};

const installDependencies = async (directory: string): Promise<void> => {
	await assertNoNativeAddons(directory, true);
	const packagePath = join(directory, "package.json");
	if (!(await stat(packagePath).catch(() => null))?.isFile()) return;
	const parsed = JSON.parse(await readFile(packagePath, "utf8")) as {
		scripts?: Record<string, string>;
		dependencies?: Record<string, string>;
		optionalDependencies?: Record<string, string>;
	};
	for (const script of ["preinstall", "install", "postinstall"]) {
		if (parsed.scripts?.[script]) {
			throw new Error(`Extension packages may not define ${script} scripts.`);
		}
	}
	const dependencies = {
		...parsed.dependencies,
		...parsed.optionalDependencies,
	};
	for (const dependency of ["node-gyp", "node-pre-gyp", "prebuild-install"]) {
		if (dependencies[dependency]) {
			throw new Error(
				`Extension packages may not use native addon tooling (${dependency}).`,
			);
		}
	}
	const hasBunLock = await access(join(directory, "bun.lock")).then(
		() => true,
		() => false,
	);
	const hasNpmLock = await access(join(directory, "package-lock.json")).then(
		() => true,
		() => false,
	);
	if (!hasBunLock && !hasNpmLock) {
		throw new Error(
			"Git and marketplace extensions require a committed lockfile.",
		);
	}
	if (hasBunLock) {
		await execute("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], {
			cwd: directory,
			timeout: 120_000,
		});
	} else {
		await execute(
			"npm",
			["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
			{
				cwd: directory,
				timeout: 120_000,
			},
		);
	}
	await assertNoNativeAddons(directory, false);
};

const moveDirectory = async (
	source: string,
	destination: string,
): Promise<void> => {
	await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
	await rm(destination, { recursive: true, force: true });
	try {
		await rename(source, destination);
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== "EXDEV") throw cause;
		await cp(source, destination, { recursive: true });
		await rm(source, { recursive: true, force: true });
	}
};

export interface PreparedSource {
	readonly directory: string;
	readonly commit: string | null;
	readonly temporaryRoot: string | null;
	readonly manifest?: ExtensionManifest;
	readonly compiled?: CompiledExtension;
}

export const prepareSource = async (input: {
	readonly source: ExtensionSource;
	readonly rootDirectory: string;
	readonly marketplace: MarketplaceCatalog | null;
	readonly fetch: typeof globalThis.fetch;
}): Promise<PreparedSource> => {
	if (input.source._tag === "directory") {
		return {
			directory: resolve(input.source.path),
			commit: null,
			temporaryRoot: null,
		};
	}
	const temporaryRoot = await mkdtemp(join(tmpdir(), "zuse-extension-"));
	try {
		if (input.source._tag === "git") {
			const checkout = join(temporaryRoot, "checkout");
			await execute(
				"git",
				[
					"clone",
					"--filter=blob:none",
					"--no-checkout",
					"--",
					input.source.url,
					checkout,
				],
				{
					timeout: 120_000,
				},
			);
			const ref = input.source.ref?.trim() || "HEAD";
			await execute("git", ["-C", checkout, "checkout", "--detach", ref], {
				timeout: 60_000,
			});
			const { stdout } = await execute("git", [
				"-C",
				checkout,
				"rev-parse",
				"HEAD",
			]);
			const directory = input.source.path
				? join(checkout, input.source.path)
				: checkout;
			const rel = relative(await realpath(checkout), await realpath(directory));
			if (
				isAbsolute(input.source.path ?? "") ||
				rel === ".." ||
				rel.startsWith("../") ||
				isAbsolute(rel)
			)
				throw new Error("Extension subpath escapes its Git checkout.");
			await installDependencies(directory);
			return { directory, commit: stdout.trim(), temporaryRoot };
		}
		const catalogId = input.source.catalogId;
		const entry = input.marketplace?.entries.find(
			(candidate) => candidate.manifest.id === catalogId,
		);
		if (!entry)
			throw new Error(
				`Marketplace extension not found: ${input.source.catalogId}`,
			);
		const bytes = await fetchBounded(
			input.fetch,
			entry.archiveUrl,
			MAX_ARTIFACT_BYTES,
		);
		if (sha256(bytes) !== entry.sha256.toLowerCase())
			throw new Error("Extension artifact integrity check failed.");
		const artifact = decodeArtifact(bytes, entry.manifest);
		return {
			directory: temporaryRoot,
			temporaryRoot,
			commit: entry.commit,
			manifest: artifact.manifest,
			compiled: artifact.compiled,
		};
	} catch (cause) {
		await rm(temporaryRoot, { recursive: true, force: true });
		throw cause;
	}
};

export const activatePreparedSource = async (input: {
	readonly prepared: PreparedSource;
	readonly extensionId: string;
	readonly rootDirectory: string;
}): Promise<string> => {
	if (input.prepared.temporaryRoot === null) return input.prepared.directory;
	const revision = input.prepared.commit ?? Date.now().toString(36);
	const destination = join(
		input.rootDirectory,
		"sources",
		input.extensionId,
		basename(revision),
	);
	await moveDirectory(input.prepared.directory, destination);
	await rm(input.prepared.temporaryRoot, { recursive: true, force: true });
	return destination;
};
