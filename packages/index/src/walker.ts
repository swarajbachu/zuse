import ignore, { type Ignore } from "ignore";
import { Effect } from "effect";
import { promises as fs } from "node:fs";
import { join, relative, sep } from "node:path";

import { IndexIoError } from "./errors.ts";

const DEFAULT_IGNORES = [
  ".git",
  "node_modules",
  // The code-index sqlite lives at <root>/.zuse/index.sqlite; skip the
  // dir so we never try to index our own database file.
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

const MAX_BYTES = 1_500_000; // 1.5MB cap — bigger files get skipped (binary, lockfiles, etc.)

const isProbablyBinary = (bytes: Buffer): boolean => {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
};

const readGitignore = async (root: string): Promise<Ignore> => {
  const ig = ignore().add(DEFAULT_IGNORES);
  try {
    const txt = await fs.readFile(join(root, ".gitignore"), "utf8");
    ig.add(txt);
  } catch {
    // no .gitignore — defaults are enough
  }
  try {
    const txt = await fs.readFile(join(root, ".zuse-ignore"), "utf8");
    ig.add(txt);
  } catch {
    // optional override file
  }
  return ig;
};

const toPosix = (p: string): string => (sep === "/" ? p : p.split(sep).join("/"));

export interface WalkedFile {
  readonly relPath: string;
  readonly absPath: string;
  readonly bytes: Buffer;
}

/**
 * Recursive walker that yields one file at a time. Honors .gitignore plus
 * a built-in skip list (node_modules, .git, build outputs). Skips files
 * bigger than 1.5 MB and anything that looks binary (has a NUL byte in the
 * first 4 KB).
 *
 * Synchronous-looking generator over async fs calls — we yield each result
 * to keep peak memory bounded on a 10k-file repo.
 */
export const walkRepo = (
  root: string,
): Effect.Effect<ReadonlyArray<WalkedFile>, IndexIoError> =>
  Effect.tryPromise({
    try: async () => {
      const ig = await readGitignore(root);
      const out: WalkedFile[] = [];
      const stack: string[] = [root];
      while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: import("node:fs").Dirent[];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          const name =
            typeof entry.name === "string"
              ? entry.name
              : (entry.name as Buffer).toString();
          const abs = join(dir, name);
          const rel = toPosix(relative(root, abs));
          if (rel === "" || rel.startsWith("..")) continue;
          const probe = entry.isDirectory() ? `${rel}/` : rel;
          if (ig.ignores(probe)) continue;
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            stack.push(abs);
            continue;
          }
          if (!entry.isFile()) continue;
          let stat;
          try {
            stat = await fs.stat(abs);
          } catch {
            continue;
          }
          if (stat.size > MAX_BYTES) continue;
          let bytes: Buffer;
          try {
            bytes = Buffer.from(await fs.readFile(abs));
          } catch {
            continue;
          }
          if (isProbablyBinary(bytes)) continue;
          out.push({ relPath: rel, absPath: abs, bytes });
        }
      }
      return out;
    },
    catch: (cause) =>
      new IndexIoError({
        path: root,
        reason: "walk failed",
        cause,
      }),
  });
