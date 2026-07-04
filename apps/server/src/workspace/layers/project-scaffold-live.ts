import { Command, CommandExecutor, FileSystem, Path } from "@effect/platform";
import { Effect, Layer, Stream } from "effect";
import * as os from "node:os";

import {
  GithubRepoSummary,
  type ProjectTemplate,
  WorkspaceCloneFailedError,
  WorkspaceCreateFailedError,
  WorkspaceInvalidPathError,
} from "@zuse/wire";

import {
  deriveCloneTargetName,
  isValidProjectName,
  ProjectScaffold,
} from "../services/project-scaffold.ts";

/**
 * Drain stdout + stderr together so we can include them in error
 * messages without losing whatever the tool printed before exit. Same
 * pattern `GitServiceLive` uses for `git`/`gh` runs.
 */
const collectText = (
  s: Stream.Stream<Uint8Array, import("@effect/platform/Error").PlatformError>,
) =>
  s.pipe(
    Stream.decodeText("utf-8"),
    Stream.runFold("", (acc, chunk) => acc + chunk),
  );

/**
 * Resolve a "parent dir" hint from the renderer. Empty string means
 * "pick a sensible default" — we prefer `~/Developer` because that's
 * where the rest of the user's projects already live in the
 * screenshots, but we fall back to `~` so a fresh-laptop user doesn't
 * see a confusing error.
 */
const resolveParent = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  parent: string,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const trimmed = parent.trim();
    if (trimmed.length > 0) return path.resolve(trimmed);
    const home = os.homedir();
    const developer = path.join(home, "Developer");
    const dev = yield* fs.stat(developer).pipe(Effect.option);
    return dev._tag === "Some" && dev.value.type === "Directory"
      ? developer
      : home;
  });

export const ProjectScaffoldLive = Layer.effect(
  ProjectScaffold,
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    /**
     * Run a command inside `cwd`, drain output, and return
     * `{ exitCode, stdout, stderr }`. Spawn failures (ENOENT, bad
     * argument) flow up as Effect failures so the caller can map them to
     * a domain error (e.g. "git is not installed").
     */
    const runCommand = (
      bin: string,
      args: ReadonlyArray<string>,
      cwd: string | null,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          let cmd = Command.make(bin, ...args);
          if (cwd !== null) cmd = cmd.pipe(Command.workingDirectory(cwd));
          const proc = yield* executor.start(cmd);
          const stdout = yield* collectText(proc.stdout);
          const stderr = yield* collectText(proc.stderr);
          const exitCode = yield* proc.exitCode;
          return { exitCode, stdout, stderr };
        }),
      );

    /** Best-effort `rm -rf` of a path we created during a failed scaffold. */
    const cleanupDir = (absPath: string): Effect.Effect<void> =>
      fs.remove(absPath, { recursive: true, force: true }).pipe(Effect.ignore);

    const cloneRepo: ProjectScaffold["Type"]["cloneRepo"] = (url, parent) =>
      Effect.gen(function* () {
        const derived = deriveCloneTargetName(url);
        if (derived === null) {
          return yield* Effect.fail(
            new WorkspaceCloneFailedError({
              url,
              reason:
                "Could not derive a folder name from the URL — make sure it ends in `<repo>.git` or similar.",
            }),
          );
        }
        const parentAbs = yield* resolveParent(fs, path, parent);

        // Make sure parent exists (mkdir -p semantics) before we clone
        // into it. `git clone` would error with a confusing "not a
        // directory" otherwise.
        yield* fs.makeDirectory(parentAbs, { recursive: true }).pipe(
          Effect.mapError(
            (err) =>
              new WorkspaceInvalidPathError({
                path: parentAbs,
                reason: `could not create parent directory: ${err.message ?? String(err)}`,
              }),
          ),
        );

        const target = path.join(parentAbs, derived);
        const exists = yield* fs
          .exists(target)
          .pipe(Effect.orElseSucceed(() => false));
        if (exists) {
          return yield* Effect.fail(
            new WorkspaceCloneFailedError({
              url,
              reason: `${target} already exists — pick a different parent or remove the existing folder.`,
            }),
          );
        }

        const result = yield* runCommand(
          "git",
          ["clone", "--progress", url, target],
          parentAbs,
        ).pipe(
          Effect.catchTags({
            SystemError: (err) =>
              Effect.fail(
                new WorkspaceCloneFailedError({
                  url,
                  reason:
                    err.reason === "NotFound"
                      ? "git is not installed or not on PATH."
                      : err.message ?? String(err),
                }),
              ),
            BadArgument: (err) =>
              Effect.fail(
                new WorkspaceCloneFailedError({
                  url,
                  reason: err.message ?? String(err),
                }),
              ),
          }),
        );

        if (result.exitCode !== 0) {
          // Leave nothing behind on the filesystem — a half-cloned dir
          // would block a retry with the same URL.
          yield* cleanupDir(target);
          return yield* Effect.fail(
            new WorkspaceCloneFailedError({
              url,
              reason:
                result.stderr.trim() ||
                result.stdout.trim() ||
                `git clone exited with code ${result.exitCode}`,
            }),
          );
        }

        return target;
      });

    /**
     * Run one scaffold step. Any non-zero exit or spawn error becomes a
     * `WorkspaceCreateFailedError` tagged with the supplied `step`, so
     * the dialog can point the user at the right corrective action.
     */
    const runStep = (
      name: string,
      step: WorkspaceCreateFailedError["step"],
      bin: string,
      args: ReadonlyArray<string>,
      cwd: string | null,
    ): Effect.Effect<void, WorkspaceCreateFailedError> =>
      Effect.gen(function* () {
        const result = yield* runCommand(bin, args, cwd).pipe(
          Effect.catchTags({
            SystemError: (err) =>
              Effect.fail(
                new WorkspaceCreateFailedError({
                  name,
                  step,
                  reason:
                    err.reason === "NotFound"
                      ? `${bin} is not installed or not on PATH.`
                      : err.message ?? String(err),
                }),
              ),
            BadArgument: (err) =>
              Effect.fail(
                new WorkspaceCreateFailedError({
                  name,
                  step,
                  reason: err.message ?? String(err),
                }),
              ),
          }),
        );
        if (result.exitCode !== 0) {
          return yield* Effect.fail(
            new WorkspaceCreateFailedError({
              name,
              step,
              reason:
                result.stderr.trim() ||
                result.stdout.trim() ||
                `${bin} exited with code ${result.exitCode}`,
            }),
          );
        }
      });

    const createFromTemplate: ProjectScaffold["Type"]["createFromTemplate"] = (
      name,
      parent,
      template,
      alsoCreateGithubRepo,
    ) =>
      Effect.gen(function* () {
        if (!isValidProjectName(name)) {
          return yield* Effect.fail(
            new WorkspaceCreateFailedError({
              name,
              step: "mkdir",
              reason:
                "Use lowercase letters, digits, dashes, and underscores only (must start with a letter or digit).",
            }),
          );
        }

        const parentAbs = yield* resolveParent(fs, path, parent);
        yield* fs.makeDirectory(parentAbs, { recursive: true }).pipe(
          Effect.mapError(
            (err) =>
              new WorkspaceInvalidPathError({
                path: parentAbs,
                reason: `could not create parent directory: ${err.message ?? String(err)}`,
              }),
          ),
        );

        const target = path.join(parentAbs, name);
        const exists = yield* fs
          .exists(target)
          .pipe(Effect.orElseSucceed(() => false));
        if (exists) {
          return yield* Effect.fail(
            new WorkspaceCreateFailedError({
              name,
              step: "mkdir",
              reason: `${target} already exists — pick a different name.`,
            }),
          );
        }

        // From here on we may have created the directory; if any step
        // fails we sweep it so the user can retry cleanly.
        const scaffold = Effect.gen(function* () {
          if (template === "empty") {
            yield* fs.makeDirectory(target, { recursive: true }).pipe(
              Effect.mapError(
                (err) =>
                  new WorkspaceCreateFailedError({
                    name,
                    step: "mkdir",
                    reason: err.message ?? String(err),
                  }),
              ),
            );
            yield* runStep(name, "git-init", "git", ["init"], target);
          } else if (template === "nextjs") {
            // `--yes` makes create-next-app skip every prompt; the rest
            // pin sensible defaults so the user lands in a working app.
            yield* runStep(
              name,
              "template",
              "bunx",
              [
                "--bun",
                "create-next-app@latest",
                name,
                "--ts",
                "--tailwind",
                "--app",
                "--eslint",
                "--src-dir",
                "--use-bun",
                "--import-alias",
                "@/*",
                "--no-turbopack",
                "--skip-install",
                "--yes",
              ],
              parentAbs,
            );
            yield* runStep(name, "install", "bun", ["install"], target);
            // create-next-app already inits git when none is present;
            // re-running `git init` is a safe no-op if it did.
            yield* runStep(name, "git-init", "git", ["init"], target);
          } else if (template === "turborepo") {
            yield* runStep(
              name,
              "template",
              "bunx",
              [
                "--bun",
                "create-turbo@latest",
                name,
                "--package-manager",
                "bun",
                "--skip-install",
              ],
              parentAbs,
            );
            yield* runStep(name, "install", "bun", ["install"], target);
            yield* runStep(name, "git-init", "git", ["init"], target);
          } else {
            // Exhaustiveness — `ProjectTemplate` is a closed literal.
            const _exhaustive: never = template;
            void _exhaustive;
          }

          if (alsoCreateGithubRepo) {
            yield* runStep(
              name,
              "gh-create",
              "gh",
              [
                "repo",
                "create",
                name,
                "--private",
                "--source",
                ".",
                "--push",
              ],
              target,
            );
          }
        });

        const result = yield* scaffold.pipe(
          Effect.catchAll((err) =>
            cleanupDir(target).pipe(Effect.zipRight(Effect.fail(err))),
          ),
          Effect.exit,
        );
        if (result._tag === "Failure") {
          return yield* Effect.failCause(result.cause);
        }
        return target;
      });

    const listGithubRepos: ProjectScaffold["Type"]["listGithubRepos"] = (
      limit,
    ) =>
      Effect.gen(function* () {
        const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
        const result = yield* runCommand(
          "gh",
          [
            "repo",
            "list",
            "--json",
            "nameWithOwner,description,sshUrl,url,isPrivate,updatedAt",
            "--limit",
            String(safeLimit),
          ],
          null,
        ).pipe(Effect.option);
        if (result._tag === "None") {
          return [] as ReadonlyArray<GithubRepoSummary>;
        }
        if (result.value.exitCode !== 0) {
          return [] as ReadonlyArray<GithubRepoSummary>;
        }
        const parsed = yield* Effect.try({
          try: () => JSON.parse(result.value.stdout) as unknown,
          catch: () => new Error("parse"),
        }).pipe(Effect.option);
        if (parsed._tag === "None" || !Array.isArray(parsed.value)) {
          return [] as ReadonlyArray<GithubRepoSummary>;
        }
        const out: GithubRepoSummary[] = [];
        for (const row of parsed.value) {
          if (row === null || typeof row !== "object") continue;
          const r = row as Record<string, unknown>;
          if (
            typeof r.nameWithOwner !== "string" ||
            typeof r.sshUrl !== "string" ||
            typeof r.url !== "string" ||
            typeof r.isPrivate !== "boolean" ||
            typeof r.updatedAt !== "string"
          ) {
            continue;
          }
          out.push(
            GithubRepoSummary.make({
              nameWithOwner: r.nameWithOwner,
              description:
                typeof r.description === "string" && r.description.length > 0
                  ? r.description
                  : null,
              sshUrl: r.sshUrl,
              httpsUrl: r.url,
              isPrivate: r.isPrivate,
              updatedAt: new Date(r.updatedAt),
            }),
          );
        }
        return out;
      });

    const ghAuthStatus: ProjectScaffold["Type"]["ghAuthStatus"] = () =>
      runCommand("gh", ["auth", "status"], null).pipe(
        Effect.map((r) => ({ authenticated: r.exitCode === 0 })),
        Effect.catchAll(() => Effect.succeed({ authenticated: false })),
      );

    return {
      cloneRepo,
      createFromTemplate,
      listGithubRepos,
      ghAuthStatus,
    } as const;
  }),
);

/**
 * Re-export the closed union so other server modules (e.g. handler tests)
 * can spell out template ids without re-importing from `@zuse/wire`.
 */
export type { ProjectTemplate };
