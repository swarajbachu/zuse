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
const TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist"] as const;

/** Safety backstop against pathological trees; real env files sit 1-3 levels deep. */
const MAX_DEPTH = 6;

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
export const linkEnvFiles = async (
  repoPath: string,
  worktreePath: string,
): Promise<string> => {
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

      const source = Path.join(repoPath, rel);
      const target = Path.join(worktreePath, rel);
      if (fsSync.existsSync(target)) continue;

      await fs.mkdir(Path.dirname(target), { recursive: true });
      await fs.symlink(source, target, "file");
      output += `linked ${rel} -> ${source}\n`;
    }
  };

  await walk("", 0);
  return output;
};
