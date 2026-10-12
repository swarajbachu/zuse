import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as Path from "node:path";

/**
 * Directories that never hold app env files and/or are huge — pruned from the
 * recursive walk so it stays fast even on large monorepos.
 */
const PRUNED_DIRS = new Set<string>([
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	".turbo",
	".cache",
	"coverage",
	"vendor",
	"target",
	".zuse",
]);

/**
 * Template/sample env files that carry no secrets and are meant to be committed.
 * They're tracked (so already materialized in the worktree checkout) and pointless
 * to link — excluding them keeps the setup output clean.
 */
const TEMPLATE_SUFFIXES = [
	".example",
	".sample",
	".template",
	".dist",
] as const;

/** Safety backstop against pathological trees; real env files sit 1-3 levels deep. */
const MAX_DEPTH = 6;

const toPosix = (value: string): string => value.split(Path.sep).join("/");

const normalizePattern = (value: string): string | null => {
	const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	// Include patterns name files inside the repo only — absolute paths and
	// `..` segments would resolve outside it for the source and outside the
	// worktree for the link target.
	if (
		normalized.length === 0 ||
		normalized.startsWith("/") ||
		normalized.split("/").some((segment) => segment === "..")
	) {
		return null;
	}
	return normalized;
};

const globToRegExp = (pattern: string): RegExp => {
	let out = "^";
	for (let i = 0; i < pattern.length; i += 1) {
		const char = pattern.charAt(i);
		const next = pattern[i + 1];
		if (char === "*" && next === "*") {
			out += ".*";
			i += 1;
		} else if (char === "*") {
			out += "[^/]*";
		} else if (char === "?") {
			out += "[^/]";
		} else {
			out += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
		}
	}
	return new RegExp(`${out}$`);
};

const parseIncludeGlobs = (raw: string): string[] =>
	raw
		.split(/\r?\n/)
		.map(normalizePattern)
		.filter((line): line is string => line !== null && !line.startsWith("#"));

const hasGlobMagic = (pattern: string): boolean =>
	pattern.includes("*") || pattern.includes("?");

/**
 * True for secret env files we want to bring into a worktree:
 * - `.env`, `.env.*` (e.g. `.env.local`, `.env.production`)
 * - `.dev.vars`, `.dev.vars.*` (Cloudflare Wrangler)
 *
 * False for template/sample variants (`.env.example`, `.env.sample`, …) and for
 * unrelated files like `.envrc` or a bare `env`.
 */
export const isEnvFileName = (name: string): boolean => {
	const isEnv = name === ".env" || name.startsWith(".env.");
	const isDevVars = name === ".dev.vars" || name.startsWith(".dev.vars.");
	if (!isEnv && !isDevVars) return false;
	return !TEMPLATE_SUFFIXES.some((suffix) => name.endsWith(suffix));
};

/**
 * Recursively discover env files anywhere under `repoPath` and symlink each into
 * `worktreePath` at the same relative location, so the worktree's env file *is* the
 * repo's env file (one source of truth, no drift) — mirroring how `node_modules` is
 * symlinked. Existing targets are left untouched (non-clobber). Returns a
 * human-readable summary streamed to the worktree setup UI.
 */
/**
 * Symlink `repoPath/rel` into `worktreePath/rel`, but only while both ends stay
 * inside their realpath'd roots. A committed symlink that points out of the
 * repo (`.env -> ~/.ssh/id_rsa`) or a symlinked directory inside the worktree
 * path must never turn an include into a host-file leak or arbitrary link
 * placement. Returns the `linked …` summary line, or null when skipped.
 */
const linkContainedFile = async (
	repoPath: string,
	worktreePath: string,
	rel: string,
	realRepoRoot: string,
	realWorktreeRoot: string,
): Promise<string | null> => {
	const source = Path.join(repoPath, rel);
	const target = Path.join(worktreePath, rel);
	if (fsSync.existsSync(target)) return null;

	const realSource = await fs.realpath(source).catch(() => null);
	if (
		realSource === null ||
		(realSource !== realRepoRoot &&
			!realSource.startsWith(`${realRepoRoot}${Path.sep}`))
	) {
		return null;
	}

	await fs.mkdir(Path.dirname(target), { recursive: true });
	const realTargetDir = await fs
		.realpath(Path.dirname(target))
		.catch(() => null);
	if (
		realTargetDir === null ||
		(realTargetDir !== realWorktreeRoot &&
			!realTargetDir.startsWith(`${realWorktreeRoot}${Path.sep}`))
	) {
		return null;
	}

	await fs.symlink(source, target, "file");
	return `linked ${toPosix(rel)} -> ${source}\n`;
};

const containedRoots = async (
	repoPath: string,
	worktreePath: string,
): Promise<{ readonly repo: string; readonly worktree: string } | null> => {
	try {
		const [repo, worktree] = await Promise.all([
			fs.realpath(repoPath),
			fs.realpath(worktreePath),
		]);
		return { repo, worktree };
	} catch {
		return null;
	}
};

export const linkEnvFiles = async (
	repoPath: string,
	worktreePath: string,
): Promise<string> => {
	const roots = await containedRoots(repoPath, worktreePath);
	if (roots === null) return "";
	let output = "";

	const walk = async (relDir: string, depth: number): Promise<void> => {
		const absDir = relDir === "" ? repoPath : Path.join(repoPath, relDir);
		let entries: fsSync.Dirent[];
		try {
			entries = await fs.readdir(absDir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const rel = relDir === "" ? entry.name : Path.join(relDir, entry.name);

			if (entry.isDirectory()) {
				if (depth >= MAX_DEPTH) continue;
				if (PRUNED_DIRS.has(entry.name)) continue;
				// Stay inside this repo: skip submodules / nested repos / stray worktrees.
				if (fsSync.existsSync(Path.join(repoPath, rel, ".git"))) continue;
				await walk(rel, depth + 1);
				continue;
			}

			// Link regular files and symlinked files only (matches node_modules guard).
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;
			if (!isEnvFileName(entry.name)) continue;

			const line = await linkContainedFile(
				repoPath,
				worktreePath,
				rel,
				roots.repo,
				roots.worktree,
			);
			if (line !== null) output += line;
		}
	};

	await walk("", 0);
	return output;
};

export const linkIncludedFiles = async (
	repoPath: string,
	worktreePath: string,
	includeGlobs: string,
): Promise<string> => {
	const patterns = parseIncludeGlobs(includeGlobs);
	if (patterns.length === 0) return linkEnvFiles(repoPath, worktreePath);

	const roots = await containedRoots(repoPath, worktreePath);
	if (roots === null) return "";

	const exact = new Set(patterns.filter((pattern) => !hasGlobMagic(pattern)));
	const globs = patterns
		.filter(hasGlobMagic)
		.map((pattern) => globToRegExp(pattern));
	const matches: string[] = [];

	const maybeAdd = (rel: string): void => {
		const posixRel = toPosix(rel);
		if (exact.has(posixRel) || globs.some((glob) => glob.test(posixRel))) {
			matches.push(rel);
		}
	};

	for (const rel of exact) {
		const abs = Path.join(repoPath, rel);
		try {
			const stat = await fs.lstat(abs);
			if (stat.isFile() || stat.isSymbolicLink()) maybeAdd(rel);
		} catch {
			// Missing exact includes are ignored; they may be optional per machine.
		}
	}

	if (globs.length > 0) {
		const walk = async (relDir: string, depth: number): Promise<void> => {
			const absDir = relDir === "" ? repoPath : Path.join(repoPath, relDir);
			let entries: fsSync.Dirent[];
			try {
				entries = await fs.readdir(absDir, { withFileTypes: true });
			} catch {
				return;
			}

			for (const entry of entries) {
				const rel = relDir === "" ? entry.name : Path.join(relDir, entry.name);
				if (entry.isDirectory()) {
					if (depth >= MAX_DEPTH) continue;
					if (PRUNED_DIRS.has(entry.name)) continue;
					if (fsSync.existsSync(Path.join(repoPath, rel, ".git"))) continue;
					await walk(rel, depth + 1);
					continue;
				}
				if (!entry.isFile() && !entry.isSymbolicLink()) continue;
				maybeAdd(rel);
			}
		};
		await walk("", 0);
	}

	let output = "";
	for (const rel of [...new Set(matches)].sort()) {
		const line = await linkContainedFile(
			repoPath,
			worktreePath,
			rel,
			roots.repo,
			roots.worktree,
		);
		if (line !== null) output += line;
	}
	return output;
};
