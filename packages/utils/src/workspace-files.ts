import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import ignore, { type Ignore } from "ignore";

export const WORKSPACE_FILE_LIMIT = 1_500_000;
const EXCLUDES = [
	".git",
	".context",
	"node_modules",
	".zuse",
	"dist",
	"build",
	"out",
	".next",
	".turbo",
	"coverage",
	".cache",
	"target",
	"vendor",
	".DS_Store",
];
export async function workspaceFile(
	root: string,
	path: string,
): Promise<string> {
	const base = await realpath(root);
	const resolved = await realpath(join(base, path));
	const rel = relative(base, resolved);
	if (
		isAbsolute(path) ||
		!rel ||
		rel === ".." ||
		rel.startsWith("../") ||
		isAbsolute(rel)
	)
		throw new Error("File must stay inside the selected workspace.");
	return resolved;
}
export async function readWorkspaceText(
	root: string,
	path: string,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	const resolved = await workspaceFile(root, path);
	const file = await open(resolved, "r");
	try {
		if (!(await file.stat()).isFile())
			throw new Error("Select a regular file.");
		const bytes = Buffer.alloc(WORKSPACE_FILE_LIMIT + 1);
		let bytesRead = 0;
		while (bytesRead < bytes.length) {
			signal?.throwIfAborted();
			const result = await file.read(
				bytes,
				bytesRead,
				bytes.length - bytesRead,
				bytesRead,
			);
			if (result.bytesRead === 0) break;
			bytesRead += result.bytesRead;
		}
		signal?.throwIfAborted();
		if (bytesRead > WORKSPACE_FILE_LIMIT)
			throw new Error("File exceeds the 1.5 MB limit.");
		const content = bytes.subarray(0, bytesRead);
		if (content.includes(0)) throw new Error("Binary files are not supported.");
		return content.toString("utf8");
	} finally {
		await file.close();
	}
}
export async function* workspaceFiles(
	root: string,
	signal?: AbortSignal,
): AsyncGenerator<string> {
	const base = await realpath(root);
	const stack: { path: string; rules: { base: string; ignore: Ignore }[] }[] = [
		{ path: base, rules: [] },
	];
	while (stack.length) {
		signal?.throwIfAborted();
		const next = stack.pop();
		if (!next) break;
		const rules = [...next.rules];
		const local = ignore().add(EXCLUDES);
		for (const name of [".gitignore", ".zuse-ignore"]) {
			try {
				local.add(await readFile(join(next.path, name), "utf8"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		rules.push({ base: next.path, ignore: local });
		const entries = await readdir(next.path, { withFileTypes: true });
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			signal?.throwIfAborted();
			if (entry.isSymbolicLink()) continue;
			const path = join(next.path, entry.name);
			if (
				rules.some((rule) =>
					rule.ignore.ignores(
						relative(rule.base, path).split("\\").join("/") +
							(entry.isDirectory() ? "/" : ""),
					),
				)
			)
				continue;
			if (entry.isDirectory()) stack.push({ path, rules });
			else if (
				entry.isFile() &&
				(await stat(path)).size <= WORKSPACE_FILE_LIMIT
			)
				yield relative(base, path).split("\\").join("/");
		}
	}
}
