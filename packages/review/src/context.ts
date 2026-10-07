import { posix } from "node:path";
import { type ParseError, parse } from "jsonc-parser";
import { isRepositoryPath } from "./tools.ts";
import type { ReviewSource } from "./types.ts";

export type RepositoryContextKind =
	| "package"
	| "workspace"
	| "typescript"
	| "ci"
	| "test"
	| "convention";
export interface RepositoryContextEntry {
	readonly path: string;
	readonly side: "LEFT" | "RIGHT";
	readonly sha: string;
	readonly kind: RepositoryContextKind;
	readonly excerpt: string;
	readonly startLine: 1;
	readonly endLine: number;
	readonly truncated: boolean;
	readonly parsing: "data" | "invalid" | "not-parsed" | "truncated";
	readonly facts?: Readonly<Record<string, unknown>>;
}
export interface RepositoryContext {
	/** Repository text, including scripts and instructions, never grants execution authority. */
	readonly trust: "repository-data";
	readonly entries: readonly RepositoryContextEntry[];
	readonly presentFiles: readonly {
		path: string;
		kind: RepositoryContextKind;
	}[];
	readonly omittedEntries: number;
	readonly unreadablePaths: readonly string[];
	readonly limited: boolean;
	readonly resolution: "declared-config-only";
}
export interface RepositoryContextOptions {
	readonly maxEntries?: number;
	readonly maxCharacters?: number;
	readonly maxEntryCharacters?: number;
	readonly maxPresentFiles?: number;
}
export type ContextExcerptReader = (
	path: string,
	side: "LEFT" | "RIGHT",
	maxCharacters: number,
) => Promise<{ text: string; truncated: boolean; endLine: number }>;

function kindOf(path: string): RepositoryContextKind | null {
	const file = posix.basename(path);
	if (file === "package.json") return "package";
	if (
		["pnpm-workspace.yaml", "lerna.json", "turbo.json", "nx.json"].includes(
			file,
		)
	)
		return "workspace";
	if (/^tsconfig(?:\.[\w-]+)?\.json$/u.test(file) || file === "jsconfig.json")
		return "typescript";
	if (path.startsWith(".github/workflows/") && /\.ya?ml$/u.test(file))
		return "ci";
	if (
		/^(?:vitest|vite|jest|playwright|cypress)\.config\.[cm]?[jt]s$/u.test(
			file,
		) ||
		file === "pytest.ini" ||
		file === "vitest.workspace.ts"
	)
		return "test";
	if (
		[
			"AGENTS.md",
			"CLAUDE.md",
			"CONTEXT.md",
			"CONTEXT-MAP.md",
			"ARCHITECTURE.md",
			"README.md",
			"CONTRIBUTING.md",
		].includes(file)
	)
		return "convention";
	return null;
}
function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}
function stringMap(value: unknown): Record<string, string> {
	return Object.fromEntries(
		Object.entries(record(value) ?? {}).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
}
function extractFacts(
	kind: RepositoryContextKind,
	text: string,
): {
	parsing: "data" | "invalid" | "not-parsed";
	facts?: Readonly<Record<string, unknown>>;
} {
	if (kind !== "package" && kind !== "typescript")
		return { parsing: "not-parsed" };
	const errors: ParseError[] = [];
	const value = record(
		parse(text, errors, {
			allowTrailingComma: kind === "typescript",
			disallowComments: kind === "package",
		}),
	);
	if (!value || errors.length > 0) return { parsing: "invalid" };
	if (kind === "package")
		return {
			parsing: "data",
			facts: {
				...(typeof value.name === "string" ? { name: value.name } : {}),
				...(typeof value.packageManager === "string"
					? { packageManager: value.packageManager }
					: {}),
				scripts: stringMap(value.scripts),
				workspaces: strings(
					Array.isArray(value.workspaces)
						? value.workspaces
						: record(value.workspaces)?.packages,
				),
				dependencies: Object.keys(record(value.dependencies) ?? {}),
				devDependencies: Object.keys(record(value.devDependencies) ?? {}),
			},
		};
	const compiler = record(value.compilerOptions);
	return {
		parsing: "data",
		facts: {
			extends:
				typeof value.extends === "string"
					? [value.extends]
					: strings(value.extends),
			...(typeof compiler?.baseUrl === "string"
				? { baseUrl: compiler.baseUrl }
				: {}),
			paths: Object.fromEntries(
				Object.entries(record(compiler?.paths) ?? {}).map(([key, targets]) => [
					key,
					strings(targets),
				]),
			),
			references: Array.isArray(value.references)
				? value.references.flatMap((item) =>
						typeof record(item)?.path === "string"
							? [String(record(item)?.path)]
							: [],
					)
				: [],
		},
	};
}

/** Discovers declarations, not resolved dependencies or trusted commands. All reads share the caller's tool budget. */
export async function discoverRepositoryContext(
	source: ReviewSource,
	read: ContextExcerptReader,
	signal: AbortSignal,
	options: RepositoryContextOptions = {},
): Promise<RepositoryContext> {
	const maxEntries = options.maxEntries ?? 12;
	const maxCharacters = options.maxCharacters ?? 24_000;
	const maxEntryCharacters = options.maxEntryCharacters ?? 4_000;
	const maxPresentFiles = options.maxPresentFiles ?? 40;
	for (const value of [
		maxEntries,
		maxCharacters,
		maxEntryCharacters,
		maxPresentFiles,
	])
		if (!Number.isSafeInteger(value) || value < 0)
			throw new Error("Invalid repository context limits");
	const directories = new Set(["."]);
	for (const change of source.changes) {
		let directory = posix.dirname(change.path);
		while (directory !== "." && directory !== "/") {
			directories.add(directory);
			const parent = posix.dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	}
	const changed = new Set(source.changes.map((change) => change.path));
	const right = new Set(source.files.RIGHT);
	const candidates = [...new Set([...source.files.LEFT, ...source.files.RIGHT])]
		.flatMap((path) => {
			if (!isRepositoryPath(path)) return [];
			const kind = kindOf(path);
			if (!kind || (kind !== "ci" && !directories.has(posix.dirname(path))))
				return [];
			return [{ path, kind }];
		})
		.sort(
			(a, b) =>
				Number(changed.has(b.path)) - Number(changed.has(a.path)) ||
				a.path.split("/").length - b.path.split("/").length ||
				(a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
		);
	const requested = candidates.flatMap((item) => [
		{
			...item,
			side: (right.has(item.path) ? "RIGHT" : "LEFT") as "LEFT" | "RIGHT",
		},
		...(changed.has(item.path) &&
		right.has(item.path) &&
		source.files.LEFT.includes(item.path)
			? [{ ...item, side: "LEFT" as const }]
			: []),
	]);
	const entries: RepositoryContextEntry[] = [];
	const unreadablePaths: string[] = [];
	let characters = 0;
	let consumed = 0;
	for (const item of requested.slice(0, maxEntries)) {
		signal.throwIfAborted();
		const available = Math.min(maxEntryCharacters, maxCharacters - characters);
		if (available < 1) break;
		consumed++;
		try {
			const excerpt = await read(item.path, item.side, available);
			signal.throwIfAborted();
			characters += excerpt.text.length;
			entries.push({
				...item,
				sha:
					item.side === "RIGHT"
						? source.snapshot.headSha
						: source.snapshot.mergeBaseSha,
				excerpt: excerpt.text,
				startLine: 1,
				endLine: excerpt.endLine,
				truncated: excerpt.truncated,
				...(excerpt.truncated
					? { parsing: "truncated" as const }
					: extractFacts(item.kind, excerpt.text)),
			});
		} catch {
			signal.throwIfAborted();
			unreadablePaths.push(`${item.side}:${item.path}`);
		}
	}
	const omittedEntries = requested.length - consumed;
	return {
		trust: "repository-data",
		entries,
		presentFiles: candidates.slice(0, maxPresentFiles),
		omittedEntries,
		unreadablePaths,
		limited:
			omittedEntries > 0 ||
			unreadablePaths.length > 0 ||
			entries.some((entry) => entry.truncated || entry.parsing === "invalid") ||
			candidates.length > maxPresentFiles,
		resolution: "declared-config-only",
	};
}
