import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export interface NpmToolSpec {
	readonly name: string;
	readonly version: string;
	readonly entry: readonly string[];
}
const installs = new Map<string, Promise<string>>();
export const npmToolDirectory = (root: string, spec: NpmToolSpec) =>
	join(root, spec.name, spec.version);
export const npmToolEntry = (root: string, spec: NpmToolSpec) =>
	join(npmToolDirectory(root, spec), "node_modules", spec.name, ...spec.entry);

export async function isNpmToolInstalled(
	root: string,
	spec: NpmToolSpec,
): Promise<boolean> {
	try {
		await access(npmToolEntry(root, spec));
		return (
			(
				await readFile(
					join(npmToolDirectory(root, spec), ".install-complete"),
					"utf8",
				)
			).trim() === spec.version
		);
	} catch {
		return false;
	}
}

/** Publish only a completed install; concurrent callers share the same work and retry failures. */
export function installNpmTool(
	root: string,
	spec: NpmToolSpec,
	run: (args: readonly string[]) => Promise<unknown>,
): Promise<string> {
	if (
		!/^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/u.test(spec.name) ||
		!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(spec.version)
	)
		return Promise.reject(new Error("Invalid pinned tool specification"));
	const target = npmToolDirectory(root, spec);
	const existing = installs.get(target);
	if (existing) return existing;
	const job = (async () => {
		if (await isNpmToolInstalled(root, spec)) return npmToolEntry(root, spec);
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		const staging = await mkdtemp(join(dirname(target), ".staging-"));
		try {
			await run([
				"install",
				"--prefix",
				staging,
				"--no-fund",
				"--no-audit",
				"--save-exact",
				`${spec.name}@${spec.version}`,
			]);
			await access(join(staging, "node_modules", spec.name, ...spec.entry));
			await writeFile(join(staging, ".install-complete"), spec.version, {
				mode: 0o600,
			});
			await rm(target, { recursive: true, force: true });
			await rename(staging, target);
			return npmToolEntry(root, spec);
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	})().finally(() => installs.delete(target));
	installs.set(target, job);
	return job;
}
