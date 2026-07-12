import { createHash } from "node:crypto";

import { Effect, FileSystem, Stream } from "effect";
import {
  ChildProcess as Command,
  ChildProcessSpawner as CommandExecutor,
} from "effect/unstable/process";

import { DeployStartError } from "@zuse/contracts";

/**
 * Collect the deployable file set from a worktree: `git ls-files` (tracked +
 * untracked-but-not-ignored, so `.gitignore` is respected and node_modules
 * never appears), minus secrets (`.env*`) and VCS/tooling noise. Each file
 * is read and SHA1-hashed — the digest Vercel's file-upload API keys on.
 */

export const MAX_FILES = 5_000;
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
/** Below this total, files are inlined into the deployment request. */
export const INLINE_THRESHOLD_BYTES = 15 * 1024 * 1024;

export interface CollectedFile {
  /** Repo-relative POSIX path. */
  readonly file: string;
  readonly sha: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

const EXCLUDED_PREFIXES = [".git/", ".vercel/", ".zuse/"] as const;

const isExcluded = (path: string): boolean => {
  if (EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  const base = path.slice(path.lastIndexOf("/") + 1);
  // Secrets never leave the machine as deploy payload — env goes through the
  // proxy's env-var upsert instead.
  return base.startsWith(".env");
};

const collectText = (
  s: Stream.Stream<Uint8Array, unknown>,
): Effect.Effect<string, unknown> =>
  s.pipe(
    Stream.decodeText({ encoding: "utf-8" }),
    Stream.runFold(() => "", (acc, chunk) => acc + chunk),
  );

const listFiles = (
  executor: CommandExecutor.ChildProcessSpawner["Service"],
  cwd: string,
): Effect.Effect<ReadonlyArray<string>, DeployStartError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const cmd = Command.make(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { cwd },
      );
      const proc = yield* executor.spawn(cmd);
      const stdout = yield* collectText(proc.stdout);
      const stderr = yield* collectText(proc.stderr);
      const exitCode = yield* proc.exitCode;
      if (exitCode !== 0) {
        return yield* Effect.fail(
          new DeployStartError({
            reason: `git ls-files failed: ${String(stderr).trim()}`,
            phase: "collect",
          }),
        );
      }
      return stdout.split("\0").filter((p) => p !== "" && !isExcluded(p));
    }),
  ).pipe(
    Effect.catch((err) =>
      err instanceof DeployStartError
        ? Effect.fail(err)
        : Effect.fail(
            new DeployStartError({
              reason: err instanceof Error ? err.message : String(err),
              phase: "collect",
            }),
          ),
    ),
  );

export const collectFiles = (
  executor: CommandExecutor.ChildProcessSpawner["Service"],
  fs: FileSystem.FileSystem,
  cwd: string,
): Effect.Effect<ReadonlyArray<CollectedFile>, DeployStartError> =>
  Effect.gen(function* () {
    const paths = yield* listFiles(executor, cwd);
    if (paths.length > MAX_FILES) {
      return yield* Effect.fail(
        new DeployStartError({
          reason: `Too many files to deploy (${paths.length} > ${MAX_FILES}).`,
          phase: "collect",
        }),
      );
    }

    let total = 0;
    const files = yield* Effect.forEach(
      paths,
      (path) =>
        fs.readFile(`${cwd}/${path}`).pipe(
          Effect.map((bytes) => {
            const sha = createHash("sha1").update(bytes).digest("hex");
            return { file: path, sha, size: bytes.byteLength, bytes };
          }),
          // Races with the working tree (file deleted between ls-files and
          // read) drop the entry rather than failing the whole deploy.
          Effect.catch(() => Effect.succeed(null)),
        ),
      { concurrency: 16 },
    );

    const out: CollectedFile[] = [];
    for (const file of files) {
      if (file === null) continue;
      total += file.size;
      out.push(file);
    }
    if (total > MAX_TOTAL_BYTES) {
      return yield* Effect.fail(
        new DeployStartError({
          reason: `Deploy too large (${Math.round(total / 1024 / 1024)}MB > ${MAX_TOTAL_BYTES / 1024 / 1024}MB).`,
          phase: "collect",
        }),
      );
    }
    return out;
  });

export const totalBytes = (files: ReadonlyArray<CollectedFile>): number =>
  files.reduce((sum, f) => sum + f.size, 0);
