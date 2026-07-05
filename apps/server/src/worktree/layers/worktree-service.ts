import { Command, CommandExecutor, FileSystem } from "@effect/platform";
import { SqlClient } from "@effect/sql";
import { Effect, Exit, Layer, Mailbox, Stream } from "effect";
import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as Path from "node:path";

import {
  type FolderId,
  PokemonSummary,
  Worktree,
  WorktreeCreateError,
  WorktreeDirtyError,
  WorktreeId,
  WorktreeNotFoundError,
  WorktreeRemoveError,
  WorktreeSetupChunk,
  type WorktreeSetupEvent,
  WorktreeSetupError,
  WorktreeSetupStatusEvent,
  type WorktreeSetupStatus,
} from "@zuse/wire";

import { RepositorySettingsService } from "../../repository-settings/services/repository-settings-service.ts";
import { WorkspaceService } from "../../workspace/services/workspace-service.ts";
import { allocatePokemonName } from "../../pokemon/allocator.ts";
import {
  POKEMON_BY_NUMBER,
  POKEMON_CATALOG,
  pokemonSpriteSourcesFor,
  pokemonSpriteStem,
} from "../../pokemon/catalog.ts";
import { PokemonService } from "../../pokemon/services/pokemon-service.ts";
import {
  WorktreeService,
  type WorktreeRestoreSnapshot,
} from "../services/worktree-service.ts";
import { linkIncludedFiles } from "./env-files.ts";

interface WorktreeRow {
  readonly id: string;
  readonly project_id: string;
  readonly path: string;
  readonly name: string;
  readonly branch: string;
  readonly base_branch: string;
  readonly created_at: string;
  readonly setup_status: string;
  readonly setup_output: string;
  readonly setup_started_at: string | null;
  readonly setup_finished_at: string | null;
  readonly pokemon_number: number | null;
}

// Time-box the base-branch `git fetch` so a hung remote can't stall worktree
// creation forever, but generous enough that a normal (even first-time) fetch
// over a slow link completes well within it. On timeout we fail loudly rather
// than basing the worktree off a stale local ref.
const FETCH_TIMEOUT = "60 seconds" as const;

const isSetupStatus = (value: string): value is WorktreeSetupStatus =>
  value === "pending" ||
  value === "running" ||
  value === "succeeded" ||
  value === "failed" ||
  value === "skipped";

const variantIdForWorktreeName = (
  pokemon: NonNullable<ReturnType<typeof POKEMON_BY_NUMBER.get>>,
  worktreeName: string,
): string => {
  const match = /-v(\d+)$/.exec(worktreeName);
  if (match === null) return "default";
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version < 2) return "default";
  const sources = pokemonSpriteSourcesFor(pokemon);
  return sources[(version - 1) % sources.length]?.id ?? "default";
};

const pokemonSummaryFor = (
  number: number | null,
  worktreeName: string,
): PokemonSummary | null => {
  if (number === null) return null;
  const pokemon = POKEMON_BY_NUMBER.get(number);
  if (pokemon === undefined) return null;
  const variantId = variantIdForWorktreeName(pokemon, worktreeName);
  return PokemonSummary.make({
    number: pokemon.number,
    slug: pokemon.slug,
    name: pokemon.name,
    generation: pokemon.generation,
    rarity: pokemon.rarity,
    points: pokemon.points,
    spriteUrl: `zuse://pokemon/${pokemonSpriteStem(pokemon.number, variantId)}`,
  });
};

const rowToWorktree = (row: WorktreeRow): Worktree =>
  Worktree.make({
    id: WorktreeId.make(row.id),
    projectId: row.project_id as FolderId,
    path: row.path,
    name: row.name,
    branch: row.branch,
    baseBranch: row.base_branch,
    createdAt: new Date(row.created_at),
    setupStatus: isSetupStatus(row.setup_status) ? row.setup_status : "pending",
    setupOutput: row.setup_output,
    setupStartedAt:
      row.setup_started_at === null ? null : new Date(row.setup_started_at),
    setupFinishedAt:
      row.setup_finished_at === null ? null : new Date(row.setup_finished_at),
    pokemon: pokemonSummaryFor(row.pokemon_number, row.name),
  });

const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_SETUP_OUTPUT = 80_000;
const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
] as const;

const truncateOutput = (value: string): string =>
  value.length <= MAX_SETUP_OUTPUT
    ? value
    : value.slice(value.length - MAX_SETUP_OUTPUT);

const readIfExists = async (path: string): Promise<Buffer | null> => {
  try {
    return await fs.readFile(path);
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
};

const matchingLockfile = async (
  repoPath: string,
  worktreePath: string,
): Promise<boolean> => {
  for (const lockfile of LOCKFILES) {
    const source = await readIfExists(Path.join(repoPath, lockfile));
    const target = await readIfExists(Path.join(worktreePath, lockfile));
    if (source !== null || target !== null) {
      return (
        source !== null &&
        target !== null &&
        source.length === target.length &&
        source.equals(target)
      );
    }
  }
  return false;
};

const isEmptyDirectory = async (path: string): Promise<boolean> => {
  try {
    const entries = await fs.readdir(path);
    return entries.length === 0;
  } catch {
    return false;
  }
};

const prepareLocalFiles = async (
  repoPath: string,
  worktreePath: string,
  includeGlobs: string,
): Promise<string> => {
  let output = "";

  const sourceNodeModules = Path.join(repoPath, "node_modules");
  const targetNodeModules = Path.join(worktreePath, "node_modules");
  if (
    fsSync.existsSync(sourceNodeModules) &&
    (await matchingLockfile(repoPath, worktreePath))
  ) {
    let canLink = false;
    try {
      const stat = await fs.lstat(targetNodeModules);
      if (stat.isSymbolicLink()) {
        output += "node_modules already symlinked\n";
      } else if (
        stat.isDirectory() &&
        (await isEmptyDirectory(targetNodeModules))
      ) {
        await fs.rmdir(targetNodeModules);
        canLink = true;
      } else {
        output += "node_modules exists; leaving it untouched\n";
      }
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "ENOENT"
      ) {
        canLink = true;
      } else {
        throw err;
      }
    }
    if (canLink) {
      await fs.symlink(sourceNodeModules, targetNodeModules, "dir");
      output += `linked node_modules -> ${sourceNodeModules}\n`;
    }
  }

  output += await linkIncludedFiles(repoPath, worktreePath, includeGlobs);

  return output;
};

const runShellScript = ({
  script,
  cwd,
  env,
  onData,
}: {
  readonly script: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Fired on every stdout/stderr chunk with the full accumulated output. */
  readonly onData?: (accumulated: string) => void;
}): Promise<{ readonly exitCode: number | null; readonly output: string }> =>
  new Promise((resolve, reject) => {
    let output = "";
    let timedOut = false;
    const child = spawn("/bin/zsh", ["-lc", script], {
      cwd,
      env: { ...(process.env as Record<string, string>), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (chunk: unknown) => {
      output = truncateOutput(output + String(chunk));
      onData?.(output);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
    }, SETUP_TIMEOUT_MS);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? 124 : code,
        output: truncateOutput(output),
      });
    });
  });

export const WorktreeServiceLive = Layer.effect(
  WorktreeService,
  Effect.gen(function* () {
    const workspace = yield* WorkspaceService;
    const repositorySettings = yield* RepositorySettingsService;
    const pokemonService = yield* PokemonService;
    const executor = yield* CommandExecutor.CommandExecutor;
    const fs = yield* FileSystem.FileSystem;
    const sql = yield* SqlClient.SqlClient;

    const worktreeColumns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(worktrees)
    `.pipe(Effect.orDie);
    const hasWorktreeColumn = (name: string): boolean =>
      worktreeColumns.some((column) => column.name === name);
    if (!hasWorktreeColumn("setup_status")) {
      yield* sql`
        ALTER TABLE worktrees
          ADD COLUMN setup_status TEXT NOT NULL DEFAULT 'pending'
      `.pipe(Effect.orDie);
    }
    if (!hasWorktreeColumn("setup_output")) {
      yield* sql`
        ALTER TABLE worktrees
          ADD COLUMN setup_output TEXT NOT NULL DEFAULT ''
      `.pipe(Effect.orDie);
    }
    if (!hasWorktreeColumn("setup_started_at")) {
      yield* sql`
        ALTER TABLE worktrees
          ADD COLUMN setup_started_at TEXT
      `.pipe(Effect.orDie);
    }
    if (!hasWorktreeColumn("setup_finished_at")) {
      yield* sql`
        ALTER TABLE worktrees
          ADD COLUMN setup_finished_at TEXT
      `.pipe(Effect.orDie);
    }

    // Live setup-output fan-out. Each `setupStream` subscriber gets its own
    // mailbox registered here; `runSetupFor` offers events to every mailbox
    // for the worktree as setup progresses. Mirrors the pty subscriber model.
    const subscribers = new Map<
      string,
      Set<Mailbox.Mailbox<WorktreeSetupEvent>>
    >();
    const emit = (worktreeId: WorktreeId, event: WorktreeSetupEvent): void => {
      const set = subscribers.get(worktreeId);
      if (set === undefined) return;
      for (const mailbox of set) mailbox.unsafeOffer(event);
    };
    const TERMINAL_STATUSES = new Set<WorktreeSetupStatus>([
      "succeeded",
      "failed",
      "skipped",
    ]);
    // Emit a status transition; on a terminal status, complete every
    // subscriber's stream so renderers stop draining once setup is done.
    const emitStatus = (
      worktreeId: WorktreeId,
      status: WorktreeSetupStatus,
      setupStartedAt: Date | null,
      setupFinishedAt: Date | null,
    ): void => {
      emit(
        worktreeId,
        WorktreeSetupStatusEvent.make({
          worktreeId,
          status,
          setupStartedAt,
          setupFinishedAt,
        }),
      );
      if (TERMINAL_STATUSES.has(status)) {
        const set = subscribers.get(worktreeId);
        if (set !== undefined) {
          for (const mailbox of set) mailbox.unsafeDone(Exit.void);
          subscribers.delete(worktreeId);
        }
      }
    };

    const collectText = (
      s: Stream.Stream<
        Uint8Array,
        import("@effect/platform/Error").PlatformError
      >,
    ) =>
      s.pipe(
        Stream.decodeText("utf-8"),
        Stream.runFold("", (acc, chunk) => acc + chunk),
      );

    /**
     * Run `git ...` in `cwd`. Resolves to stdout on exit-zero; converts every
     * other outcome (non-zero exit, ENOENT, BadArgument) into a single
     * `string` error reason the callers wrap into the appropriate domain
     * error. Mirrors `GitServiceLive.run` but stays self-contained so
     * domains remain independent.
     */
    const runGit = (cwd: string, args: ReadonlyArray<string>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const cmd = Command.make("git", ...args).pipe(
            Command.workingDirectory(cwd),
          );
          const proc = yield* executor.start(cmd);
          const stdout = yield* collectText(proc.stdout);
          const stderr = yield* collectText(proc.stderr);
          const exitCode = yield* proc.exitCode;
          if (exitCode === 0) return stdout;
          return yield* Effect.fail(
            stderr.trim() || `git exited with code ${exitCode}`,
          );
        }),
      ).pipe(
        Effect.catchTags({
          SystemError: (err) =>
            Effect.fail(
              err.reason === "NotFound"
                ? "git is not installed"
                : (err.message ?? String(err)),
            ),
          BadArgument: (err) => Effect.fail(err.message ?? String(err)),
        }),
      );

    // Same shape as `runGit` but for the GitHub CLI — used when checking out a
    // PR into a new worktree (`gh pr checkout`), which handles fork remotes +
    // upstream tracking that a raw `git worktree add` can't.
    const runGh = (cwd: string, args: ReadonlyArray<string>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const cmd = Command.make("gh", ...args).pipe(
            Command.workingDirectory(cwd),
          );
          const proc = yield* executor.start(cmd);
          const stdout = yield* collectText(proc.stdout);
          const stderr = yield* collectText(proc.stderr);
          const exitCode = yield* proc.exitCode;
          if (exitCode === 0) return stdout;
          return yield* Effect.fail(
            stderr.trim() || `gh exited with code ${exitCode}`,
          );
        }),
      ).pipe(
        Effect.catchTags({
          SystemError: (err) =>
            Effect.fail(
              err.reason === "NotFound"
                ? "the GitHub CLI (gh) is not installed"
                : (err.message ?? String(err)),
            ),
          BadArgument: (err) => Effect.fail(err.message ?? String(err)),
        }),
      );

    const list: WorktreeService["Type"]["list"] = (projectId) =>
      Effect.gen(function* () {
        const rows = yield* sql<WorktreeRow>`
          SELECT id, project_id, path, name, branch, base_branch, created_at,
                 setup_status, setup_output, setup_started_at, setup_finished_at,
                 pokemon_number
          FROM worktrees
          WHERE project_id = ${projectId}
          ORDER BY created_at DESC
        `.pipe(Effect.orDie);
        return rows.map(rowToWorktree);
      });

    const get: WorktreeService["Type"]["get"] = (worktreeId) =>
      Effect.gen(function* () {
        const rows = yield* sql<WorktreeRow>`
          SELECT id, project_id, path, name, branch, base_branch, created_at,
                 setup_status, setup_output, setup_started_at, setup_finished_at,
                 pokemon_number
          FROM worktrees
          WHERE id = ${worktreeId}
          LIMIT 1
        `.pipe(Effect.orDie);
        return rows.length > 0 ? rowToWorktree(rows[0]!) : null;
      });

    const updateBranch: WorktreeService["Type"]["updateBranch"] = (
      worktreeId,
      branch,
    ) =>
      sql`
        UPDATE worktrees SET branch = ${branch} WHERE id = ${worktreeId}
      `.pipe(Effect.asVoid, Effect.orDie);

    const create: WorktreeService["Type"]["create"] = (projectId, source) =>
      Effect.gen(function* () {
        const folder = yield* workspace.findById(projectId);
        if (folder === null) {
          return yield* Effect.fail(
            new WorktreeCreateError({
              projectId,
              reason: "project not found",
            }),
          );
        }
        const repoPath = folder.path;
        // Layout: ~/.zuse/<repo-name>-<projectId-short>/<branch>/. Living
        // in the user's home dir (next to Downloads, Developer, etc.) keeps
        // the repo itself untouched — `git status`, file pickers, and any
        // tree walker stay clean. The projectId suffix disambiguates two
        // registered projects that happen to share a folder name.
        const baseDir = Path.join(
          os.homedir(),
          ".zuse",
          `${folder.name}-${folder.id.slice(0, 8)}`,
        );

        yield* fs.makeDirectory(baseDir, { recursive: true }).pipe(
          Effect.mapError(
            (err) =>
              new WorktreeCreateError({
                projectId,
                reason: `mkdir failed: ${err.message ?? String(err)}`,
              }),
          ),
        );

        // Resolve the base the new worktree branches off of. Users live in
        // worktrees and push from there, so the main checkout's local base
        // branch (e.g. `main`) is rarely pulled and goes stale — branching off
        // it would start every agent behind the remote. So:
        //   • If an `origin` remote is configured, branch off the freshly
        //     fetched `origin/<default-branch>` and FAIL LOUDLY if the remote
        //     is unreachable/unresolvable rather than silently using a stale
        //     local ref. `git fetch` only writes the remote-tracking ref — the
        //     main checkout is left exactly as-is.
        //   • If there is no `origin` at all, this is a legitimate local-only
        //     repo (nothing to be "behind"), so we base off local `HEAD`.
        const fail = (reason: string) =>
          new WorktreeCreateError({ projectId, reason });

        const remotesRaw = yield* runGit(repoPath, ["remote"]).pipe(
          Effect.orElseSucceed(() => ""),
        );
        const hasOrigin = remotesRaw
          .split("\n")
          .map((r) => r.trim())
          .includes("origin");

        let baseRef: string;
        let baseBranch: string;

        if (!hasOrigin) {
          // Local-only repo: base off the main checkout's current HEAD.
          const headRefRaw = yield* runGit(repoPath, [
            "rev-parse",
            "--abbrev-ref",
            "HEAD",
          ]).pipe(Effect.mapError(fail));
          baseBranch = headRefRaw.trim() || "HEAD";
          baseRef = "HEAD";
        } else {
          // Resolve the remote's default branch authoritatively from the
          // remote's own HEAD (`ls-remote --symref`), which also confirms the
          // remote is reachable. Fall back to probing common remote-tracking
          // refs if the symref can't be read/parsed.
          const symrefRaw = yield* runGit(repoPath, [
            "ls-remote",
            "--symref",
            "origin",
            "HEAD",
          ]).pipe(Effect.either);

          let defaultBranch: string | null = null;
          if (symrefRaw._tag === "Right") {
            const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(
              symrefRaw.right,
            );
            defaultBranch = match?.[1] ?? null;
          }

          if (defaultBranch === null) {
            // ls-remote failed or returned no symref — probe local
            // remote-tracking refs in the conventional order.
            for (const candidate of ["main", "master"]) {
              const exists = yield* runGit(repoPath, [
                "rev-parse",
                "--verify",
                "--quiet",
                `refs/remotes/origin/${candidate}`,
              ]).pipe(
                Effect.map(() => true),
                Effect.catchAll(() => Effect.succeed(false)),
              );
              if (exists) {
                defaultBranch = candidate;
                break;
              }
            }
          }

          if (defaultBranch === null) {
            return yield* Effect.fail(
              fail("could not determine origin default branch"),
            );
          }

          // Update the remote-tracking ref. Fail loudly on timeout/failure
          // rather than basing the worktree off a stale local ref.
          const fetched = yield* runGit(repoPath, [
            "fetch",
            "origin",
            defaultBranch,
          ]).pipe(Effect.timeout(FETCH_TIMEOUT), Effect.either);
          if (fetched._tag === "Left") {
            // runGit fails with a string; Effect.timeout adds a
            // TimeoutException — anything non-string is the timeout.
            const reason =
              typeof fetched.left === "string"
                ? fetched.left
                : `timed out after ${FETCH_TIMEOUT}`;
            return yield* Effect.fail(
              fail(`failed to fetch origin/${defaultBranch}: ${reason}`),
            );
          }

          const remoteRefExists = yield* runGit(repoPath, [
            "rev-parse",
            "--verify",
            "--quiet",
            `refs/remotes/origin/${defaultBranch}`,
          ]).pipe(
            Effect.map(() => true),
            Effect.catchAll(() => Effect.succeed(false)),
          );
          if (!remoteRefExists) {
            return yield* Effect.fail(
              fail(
                `origin/${defaultBranch} not found after fetch — cannot create worktree`,
              ),
            );
          }

          baseBranch = defaultBranch;
          baseRef = `origin/${defaultBranch}`;
        }

        const unavailableNames = new Set<string>();
        const existingRows = yield* sql<{ readonly name: string }>`
          SELECT name FROM worktrees WHERE project_id = ${projectId}
        `.pipe(Effect.orDie);
        for (const row of existingRows) unavailableNames.add(row.name);

        const baseEntries = yield* fs
          .readDirectory(baseDir)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
        for (const entry of baseEntries) unavailableNames.add(entry);

        const branchNamesRaw = yield* runGit(repoPath, [
          "for-each-ref",
          "--format=%(refname:short)",
          "refs/heads",
        ]).pipe(Effect.orElseSucceed(() => ""));
        for (const branchName of branchNamesRaw.split("\n")) {
          const trimmed = branchName.trim();
          if (trimmed !== "") unavailableNames.add(trimmed);
        }

        const usedPokemonRows = yield* sql<{
          readonly pokemon_number: number;
        }>`
          SELECT pokemon_number FROM pokemon_unlocks
        `.pipe(Effect.orDie);
        const usedPokemonNumbers = new Set(
          usedPokemonRows.map((row) => row.pokemon_number),
        );

        // Allocation can still race with another worktree creator, so loop
        // with newly discovered collisions fed back into the unavailable set.
        let attempt = 0;
        while (attempt < 50) {
          attempt += 1;
          const allocation = allocatePokemonName({
            catalog: POKEMON_CATALOG,
            unavailableNames,
            usedPokemonNumbers,
          });
          if (allocation === null) break;
          const { name, pokemon } = allocation;
          const branch = name;
          const target = Path.join(baseDir, name);

          const targetExists = yield* fs
            .exists(target)
            .pipe(Effect.catchAll(() => Effect.succeed(false)));
          if (targetExists) {
            unavailableNames.add(name);
            continue;
          }

          const dupes = yield* sql<{ id: string }>`
            SELECT id FROM worktrees
            WHERE project_id = ${projectId} AND name = ${name}
            LIMIT 1
          `.pipe(Effect.orDie);
          if (dupes.length > 0) {
            unavailableNames.add(name);
            continue;
          }

          // Skip if a branch with this name already exists in the repo —
          // `git worktree add -b` would fail and we'd surface a confusing
          // error. Cheap pre-flight; cool-names rarely collide.
          const branchExists = yield* runGit(repoPath, [
            "rev-parse",
            "--verify",
            "--quiet",
            `refs/heads/${branch}`,
          ]).pipe(
            Effect.map(() => true),
            Effect.catchAll(() => Effect.succeed(false)),
          );
          if (branchExists) {
            unavailableNames.add(name);
            continue;
          }

          // The directory + mascot always get the Pokémon name; only the
          // checked-out branch varies. Default (no source): create a fresh
          // branch `<pokemon>` off baseRef. With a source: check out the
          // EXISTING branch / PR the "Create from…" picker chose.
          let checkedOutBranch = branch;
          const addResult = yield* Effect.gen(function* () {
            if (source === undefined) {
              // git worktree add -b <branch> <target> <baseRef>
              // baseRef is the freshly-fetched `origin/<branch>` when available,
              // otherwise local `HEAD` (see baseRef resolution above).
              return yield* runGit(repoPath, [
                "worktree",
                "add",
                "-b",
                branch,
                target,
                baseRef,
              ]);
            }
            if (source._tag === "branch") {
              checkedOutBranch = source.branch;
              const localExists = yield* runGit(repoPath, [
                "rev-parse",
                "--verify",
                "--quiet",
                `refs/heads/${source.branch}`,
              ]).pipe(
                Effect.map(() => true),
                Effect.catchAll(() => Effect.succeed(false)),
              );
              if (localExists) {
                // Check out the existing local branch directly.
                return yield* runGit(repoPath, [
                  "worktree",
                  "add",
                  target,
                  source.branch,
                ]);
              }
              // Remote-only branch: fetch it, then add a tracking local branch.
              const remoteName = source.remote ?? "origin";
              yield* runGit(repoPath, [
                "fetch",
                remoteName,
                source.branch,
              ]).pipe(Effect.either);
              return yield* runGit(repoPath, [
                "worktree",
                "add",
                "--track",
                "-b",
                source.branch,
                target,
                `${remoteName}/${source.branch}`,
              ]);
            }
            // PR: add the worktree detached at the base, then let `gh pr
            // checkout` switch it onto the PR head (handles fork remotes +
            // tracking). `checkedOutBranch` becomes the PR's head branch.
            checkedOutBranch = source.headRefName;
            yield* runGit(repoPath, [
              "worktree",
              "add",
              "--detach",
              target,
              baseRef,
            ]);
            yield* runGh(target, ["pr", "checkout", String(source.number)]);
            return "";
          }).pipe(Effect.either);
          if (addResult._tag === "Left") {
            // Clean up a half-created worktree dir so the name can be retried.
            yield* runGit(repoPath, [
              "worktree",
              "remove",
              "--force",
              target,
            ]).pipe(Effect.either);
            return yield* Effect.fail(
              new WorktreeCreateError({
                projectId,
                reason: addResult.left,
              }),
            );
          }

          const id = WorktreeId.make(crypto.randomUUID());
          const now = new Date();
          const nowIso = now.toISOString();
          yield* sql`
            INSERT INTO worktrees
              (id, project_id, path, name, branch, base_branch, created_at,
               setup_status, setup_output, pokemon_number)
            VALUES
              (${id}, ${projectId}, ${target}, ${name}, ${checkedOutBranch}, ${baseBranch}, ${nowIso},
               'pending', '', ${pokemon.number})
          `.pipe(Effect.orDie);
          yield* pokemonService.recordUnlock(pokemon.number, id);
          // Setup runs detached so `create` returns as soon as the worktree +
          // branch exist. The renderer subscribes to `setupStream` to follow
          // setup live; the row starts `pending` and flips to `running` once
          // the forked setup begins.
          const created = (yield* get(id))!;
          yield* Effect.forkDaemon(runSetupSafely(id));
          return created;
        }
        return yield* Effect.fail(
          new WorktreeCreateError({
            projectId,
            reason: "could not pick a unique Pokémon worktree name",
          }),
        );
      });

    const remove: WorktreeService["Type"]["remove"] = (worktreeId, force) =>
      Effect.gen(function* () {
        const row = yield* get(worktreeId);
        if (row === null) {
          return yield* Effect.fail(new WorktreeNotFoundError({ worktreeId }));
        }
        const folder = yield* workspace.findById(row.projectId);
        if (folder === null) {
          // Project gone; just drop the row and let disk be.
          yield* sql`DELETE FROM worktrees WHERE id = ${worktreeId}`.pipe(
            Effect.orDie,
          );
          return;
        }

        const args = ["worktree", "remove"] as string[];
        if (force) args.push("--force");
        args.push(row.path);
        const result = yield* runGit(folder.path, args).pipe(Effect.either);
        if (result._tag === "Left") {
          const lower = result.left.toLowerCase();
          if (
            !force &&
            (lower.includes("contains modified or untracked files") ||
              lower.includes("is dirty") ||
              lower.includes("has changes"))
          ) {
            return yield* Effect.fail(new WorktreeDirtyError({ worktreeId }));
          }
          return yield* Effect.fail(
            new WorktreeRemoveError({ worktreeId, reason: result.left }),
          );
        }

        yield* sql`DELETE FROM worktrees WHERE id = ${worktreeId}`.pipe(
          Effect.orDie,
        );
      });

    const restore: WorktreeService["Type"]["restore"] = (
      snapshot: WorktreeRestoreSnapshot,
    ) =>
      Effect.gen(function* () {
        const folder = yield* workspace.findById(snapshot.projectId);
        if (folder === null) {
          return yield* Effect.fail(
            new WorktreeRemoveError({
              worktreeId: snapshot.id,
              reason: "project not found",
            }),
          );
        }

        const existing = yield* get(snapshot.id);
        if (existing !== null) return existing;

        const targetExists = yield* fs
          .exists(snapshot.path)
          .pipe(Effect.catchAll(() => Effect.succeed(false)));
        if (targetExists) {
          return yield* Effect.fail(
            new WorktreeRemoveError({
              worktreeId: snapshot.id,
              reason: `restore path already exists: ${snapshot.path}`,
            }),
          );
        }

        const branchExists = yield* runGit(folder.path, [
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/heads/${snapshot.branch}`,
        ]).pipe(
          Effect.map(() => true),
          Effect.catchAll(() => Effect.succeed(false)),
        );
        if (!branchExists) {
          return yield* Effect.fail(
            new WorktreeRemoveError({
              worktreeId: snapshot.id,
              reason: `branch not found: ${snapshot.branch}`,
            }),
          );
        }

        const result = yield* runGit(folder.path, [
          "worktree",
          "add",
          snapshot.path,
          snapshot.branch,
        ]).pipe(Effect.either);
        if (result._tag === "Left") {
          return yield* Effect.fail(
            new WorktreeRemoveError({
              worktreeId: snapshot.id,
              reason: result.left,
            }),
          );
        }

        const createdAtIso = snapshot.createdAt.toISOString();
        yield* sql`
          INSERT INTO worktrees
            (id, project_id, path, name, branch, base_branch, created_at,
             setup_status, setup_output)
          VALUES
            (${snapshot.id}, ${snapshot.projectId}, ${snapshot.path},
             ${snapshot.name}, ${snapshot.branch}, ${snapshot.baseBranch},
             ${createdAtIso}, 'skipped', '')
        `.pipe(Effect.orDie);

        return Worktree.make({
          id: snapshot.id,
          projectId: snapshot.projectId,
          path: snapshot.path,
          name: snapshot.name,
          branch: snapshot.branch,
          baseBranch: snapshot.baseBranch,
          createdAt: snapshot.createdAt,
          setupStatus: "skipped",
          setupOutput: "",
          setupStartedAt: null,
          setupFinishedAt: null,
          pokemon: null,
        });
      });

    const setupEnv = (
      repoPath: string,
      worktree: Worktree,
      env: Readonly<Record<string, string>>,
    ): Record<string, string> => ({
      ...env,
      ZUSE_ROOT_PATH: repoPath,
      ZUSE_WORKTREE_PATH: worktree.path,
      ZUSE_WORKTREE_ID: worktree.id,
      ZUSE_PORT:
        process.env.ZUSE_PORT ??
        process.env.MEMOIZE_PORT ??
        process.env.PORT ??
        "",
      MEMOIZE_ROOT_PATH: repoPath,
      MEMOIZE_WORKTREE_PATH: worktree.path,
      MEMOIZE_WORKTREE_ID: worktree.id,
      MEMOIZE_PORT:
        process.env.MEMOIZE_PORT ??
        process.env.ZUSE_PORT ??
        process.env.PORT ??
        "",
    });

    function runSetupFor(
      worktreeId: WorktreeId,
    ): Effect.Effect<Worktree, WorktreeNotFoundError | WorktreeSetupError> {
      return Effect.gen(function* () {
        const worktree = yield* get(worktreeId);
        if (worktree === null) {
          return yield* Effect.fail(new WorktreeNotFoundError({ worktreeId }));
        }
        const folder = yield* workspace.findById(worktree.projectId);
        if (folder === null) {
          return yield* Effect.fail(
            new WorktreeSetupError({ worktreeId, reason: "project not found" }),
          );
        }
        const settings = yield* repositorySettings.get(worktree.projectId);
        const script = settings.setupScript?.trim() ?? "";
        const startedAtDate = new Date();
        const startedAt = startedAtDate.toISOString();
        yield* sql`
          UPDATE worktrees
          SET setup_status = 'running',
              setup_output = '',
              setup_started_at = ${startedAt},
              setup_finished_at = NULL
          WHERE id = ${worktreeId}
        `.pipe(Effect.orDie);
        emitStatus(worktreeId, "running", startedAtDate, null);

        const prep = yield* Effect.tryPromise({
          try: () =>
            prepareLocalFiles(
              folder.path,
              worktree.path,
              settings.fileIncludeGlobs,
            ),
          catch: (err) =>
            new WorktreeSetupError({
              worktreeId,
              reason: err instanceof Error ? err.message : String(err),
            }),
        });

        // Surface the prepareLocalFiles output immediately so the card isn't
        // blank while the (possibly long) script runs.
        if (prep.length > 0) {
          emit(
            worktreeId,
            WorktreeSetupChunk.make({ worktreeId, output: prep }),
          );
        }

        if (script.length === 0) {
          const finishedAtDate = new Date();
          const finishedAt = finishedAtDate.toISOString();
          yield* sql`
            UPDATE worktrees
            SET setup_status = 'skipped',
                setup_output = ${prep},
                setup_finished_at = ${finishedAt}
            WHERE id = ${worktreeId}
          `.pipe(Effect.orDie);
          emitStatus(worktreeId, "skipped", startedAtDate, finishedAtDate);
          return (yield* get(worktreeId))!;
        }

        const result = yield* Effect.tryPromise({
          try: () =>
            runShellScript({
              script,
              cwd: worktree.path,
              env: setupEnv(
                folder.path,
                worktree,
                settings.environmentVariables,
              ),
              onData: (acc) =>
                emit(
                  worktreeId,
                  WorktreeSetupChunk.make({
                    worktreeId,
                    output: truncateOutput(`${prep}${acc}`),
                  }),
                ),
            }),
          catch: (err) =>
            new WorktreeSetupError({
              worktreeId,
              reason: err instanceof Error ? err.message : String(err),
            }),
        });
        const finishedAtDate = new Date();
        const finishedAt = finishedAtDate.toISOString();
        const status = result.exitCode === 0 ? "succeeded" : "failed";
        const output = truncateOutput(`${prep}${result.output}`);
        yield* sql`
          UPDATE worktrees
          SET setup_status = ${status},
              setup_output = ${output},
              setup_finished_at = ${finishedAt}
          WHERE id = ${worktreeId}
        `.pipe(Effect.orDie);
        emit(worktreeId, WorktreeSetupChunk.make({ worktreeId, output }));
        emitStatus(worktreeId, status, startedAtDate, finishedAtDate);
        return (yield* get(worktreeId))!;
      });
    }

    /**
     * Run setup and guarantee a terminal status is always persisted + emitted
     * — even when setup throws — so a `setupStream` never hangs in `running`.
     */
    const runSetupSafely = (worktreeId: WorktreeId): Effect.Effect<void> =>
      runSetupFor(worktreeId).pipe(
        Effect.asVoid,
        Effect.catchAll((err) =>
          Effect.gen(function* () {
            const finishedAt = new Date();
            yield* sql`
              UPDATE worktrees
              SET setup_status = 'failed',
                  setup_finished_at = ${finishedAt.toISOString()}
              WHERE id = ${worktreeId}
            `.pipe(Effect.orDie);
            emitStatus(worktreeId, "failed", null, finishedAt);
            yield* Effect.logError(
              `worktree setup failed for ${worktreeId}: ${String(err)}`,
            );
          }),
        ),
      );

    const rerunSetup: WorktreeService["Type"]["rerunSetup"] = (worktreeId) =>
      Effect.gen(function* () {
        const wt = yield* get(worktreeId);
        if (wt === null) {
          return yield* Effect.fail(new WorktreeNotFoundError({ worktreeId }));
        }
        // Same non-blocking model as `create`: kick off setup detached and
        // return immediately; the renderer follows via `setupStream`.
        yield* Effect.forkDaemon(runSetupSafely(worktreeId));
        return wt;
      });

    const setupStream: WorktreeService["Type"]["setupStream"] = (worktreeId) =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          const wt = yield* get(worktreeId);
          if (wt === null) {
            return Stream.fail(new WorktreeNotFoundError({ worktreeId }));
          }
          const mailbox = yield* Mailbox.make<WorktreeSetupEvent>();
          const set = subscribers.get(worktreeId) ?? new Set();
          set.add(mailbox);
          subscribers.set(worktreeId, set);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              const s = subscribers.get(worktreeId);
              if (s === undefined) return;
              s.delete(mailbox);
              if (s.size === 0) subscribers.delete(worktreeId);
            }),
          );
          // Seed the current snapshot so a late subscriber (after a fast setup
          // already finished) still sees the latest output + terminal status.
          mailbox.unsafeOffer(
            WorktreeSetupChunk.make({
              worktreeId,
              output: wt.setupOutput,
            }),
          );
          mailbox.unsafeOffer(
            WorktreeSetupStatusEvent.make({
              worktreeId,
              status: wt.setupStatus,
              setupStartedAt: wt.setupStartedAt,
              setupFinishedAt: wt.setupFinishedAt,
            }),
          );
          // If setup already finished, complete immediately — no live events
          // are coming, so don't leave the renderer's stream hanging open.
          if (TERMINAL_STATUSES.has(wt.setupStatus)) {
            mailbox.unsafeDone(Exit.void);
          }
          return Mailbox.toStream(mailbox);
        }),
      );

    const startRun: WorktreeService["Type"]["startRun"] = (worktreeId) =>
      Effect.gen(function* () {
        const worktree = yield* get(worktreeId);
        if (worktree === null) {
          return yield* Effect.fail(new WorktreeNotFoundError({ worktreeId }));
        }
        const folder = yield* workspace.findById(worktree.projectId);
        if (folder === null) {
          return yield* Effect.fail(
            new WorktreeSetupError({ worktreeId, reason: "project not found" }),
          );
        }
        const settings = yield* repositorySettings.get(worktree.projectId);
        const script = settings.runScript?.trim() ?? "";
        if (script.length === 0) {
          return yield* Effect.fail(
            new WorktreeSetupError({
              worktreeId,
              reason: "run script is empty",
            }),
          );
        }
        return {
          cwd: worktree.path,
          script,
          env: setupEnv(folder.path, worktree, settings.environmentVariables),
        };
      });

    return {
      create,
      list,
      get,
      updateBranch,
      remove,
      restore,
      rerunSetup,
      setupStream,
      startRun,
    } as const;
  }),
);
