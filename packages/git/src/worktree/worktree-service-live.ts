import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import {
	cp as copyPath,
	mkdir as makeDirectory,
	rm as removePath,
	rename as renamePath,
} from "node:fs/promises";
import * as os from "node:os";
import * as Path from "node:path";
import {
	type FolderId,
	Worktree,
	WorktreeBranchRenameError,
	type WorktreeBranchRenameReason,
	WorktreeCheckpointError,
	WorktreeCreateError,
	WorktreeId,
	WorktreeNotFoundError,
	WorktreeRemoveError,
	WorktreeSetupChunk,
	WorktreeSetupError,
	type WorktreeSetupEvent,
	type WorktreeSetupStatus,
	WorktreeSetupStatusEvent,
} from "@zuse/contracts";
import {
	type Cause,
	DateTime,
	Effect,
	FileSystem,
	Layer,
	Queue,
	Schedule,
	Stream,
} from "effect";
import {
	ChildProcess as Command,
	ChildProcessSpawner as CommandExecutor,
} from "effect/unstable/process";
import { SqlClient } from "effect/unstable/sql";
import { linkIncludedFiles } from "./env-files.ts";
import {
	PokemonAssignment,
	ProjectLocator,
	RepositorySettingsReader,
	WorktreeDecoration,
	WorktreeNameAllocator,
} from "./ports.ts";
import {
	type WorktreeArchiveOutcome,
	type WorktreeRestoreSnapshot,
	WorktreeService,
} from "./worktree-service.ts";

interface WorktreeRow {
	readonly id: string;
	readonly project_id: string;
	readonly path: string;
	readonly name: string;
	readonly branch: string;
	readonly branch_provenance: "pending" | "automatic" | "manual";
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

const rowToWorktree = (
	row: WorktreeRow,
	pokemonSummary: WorktreeDecoration["Service"]["pokemonSummary"],
): Worktree =>
	Worktree.make({
		id: WorktreeId.make(row.id),
		projectId: row.project_id as FolderId,
		path: row.path,
		name: row.name,
		branch: row.branch,
		branchProvenance: row.branch_provenance,
		baseBranch: row.base_branch,
		createdAt: new Date(row.created_at),
		setupStatus: isSetupStatus(row.setup_status) ? row.setup_status : "pending",
		setupOutput: row.setup_output,
		setupStartedAt:
			row.setup_started_at === null ? null : new Date(row.setup_started_at),
		setupFinishedAt:
			row.setup_finished_at === null ? null : new Date(row.setup_finished_at),
		pokemon: pokemonSummary(row.pokemon_number, row.name),
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

export const WorktreeServiceLive = Layer.effect(
	WorktreeService,
	Effect.gen(function* () {
		const projects = yield* ProjectLocator;
		const repositorySettings = yield* RepositorySettingsReader;
		const nameAllocator = yield* WorktreeNameAllocator;
		const pokemonAssignment = yield* PokemonAssignment;
		const decoration = yield* WorktreeDecoration;
		const executor = yield* CommandExecutor.ChildProcessSpawner;
		const fs = yield* FileSystem.FileSystem;
		const sql = yield* SqlClient.SqlClient;
		const runShellScript = Effect.fn("WorktreeService.runShellScript")(
			function* ({
				script,
				cwd,
				env,
				onData,
			}: {
				readonly script: string;
				readonly cwd: string;
				readonly env: Readonly<Record<string, string>>;
				readonly onData?: (accumulated: string) => void;
			}) {
				return yield* Effect.scoped(
					Effect.gen(function* () {
						const command = Command.make("/bin/zsh", ["-lc", script], {
							cwd,
							env: { ...env },
							extendEnv: true,
							stdin: "ignore",
						});
						const process = yield* executor.spawn(command);
						const output = yield* process.all.pipe(
							Stream.decodeText({ encoding: "utf-8" }),
							Stream.runFold(
								() => "",
								(accumulated, chunk) => {
									const next = truncateOutput(accumulated + chunk);
									onData?.(next);
									return next;
								},
							),
						);
						const exitCode = yield* process.exitCode;
						return { exitCode, output } as const;
					}),
				).pipe(Effect.timeout(SETUP_TIMEOUT_MS));
			},
		);

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
			Set<Queue.Queue<WorktreeSetupEvent, Cause.Done>>
		>();
		const emit = (worktreeId: WorktreeId, event: WorktreeSetupEvent): void => {
			const set = subscribers.get(worktreeId);
			if (set === undefined) return;
			for (const mailbox of set) Queue.offerUnsafe(mailbox, event);
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
					for (const mailbox of set) Queue.endUnsafe(mailbox);
					subscribers.delete(worktreeId);
				}
			}
		};

		const collectText = (
			s: Stream.Stream<
				Uint8Array,
				import("effect/PlatformError").PlatformError
			>,
		) =>
			s.pipe(
				Stream.decodeText({ encoding: "utf-8" }),
				Stream.runFold(
					() => "",
					(acc, chunk) => acc + chunk,
				),
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
					const cmd = Command.make("git", args, { cwd });
					const proc = yield* executor.spawn(cmd);
					const stdout = yield* collectText(proc.stdout);
					const stderr = yield* collectText(proc.stderr);
					const exitCode = yield* proc.exitCode;
					if (exitCode === 0) return stdout;
					return yield* Effect.fail(
						stderr.trim() || `git exited with code ${exitCode}`,
					);
				}),
			).pipe(
				Effect.catchTag("PlatformError", (error) =>
					Effect.fail(
						error.reason._tag === "NotFound"
							? "git is not installed"
							: error.message,
					),
				),
			);

		// Same shape as `runGit` but for the GitHub CLI — used when checking out a
		// PR into a new worktree (`gh pr checkout`), which handles fork remotes +
		// upstream tracking that a raw `git worktree add` can't.
		const runGh = (cwd: string, args: ReadonlyArray<string>) =>
			Effect.scoped(
				Effect.gen(function* () {
					const cmd = Command.make("gh", args, { cwd });
					const proc = yield* executor.spawn(cmd);
					const stdout = yield* collectText(proc.stdout);
					const stderr = yield* collectText(proc.stderr);
					const exitCode = yield* proc.exitCode;
					if (exitCode === 0) return stdout;
					return yield* Effect.fail(
						stderr.trim() || `gh exited with code ${exitCode}`,
					);
				}),
			).pipe(
				Effect.catchTag("PlatformError", (error) =>
					Effect.fail(
						error.reason._tag === "NotFound"
							? "the GitHub CLI (gh) is not installed"
							: error.message,
					),
				),
			);

		const list: WorktreeService["Service"]["list"] = (projectId) =>
			Effect.gen(function* () {
				const rows = yield* sql<WorktreeRow>`
		  SELECT id, project_id, path, name, branch, branch_provenance, base_branch, created_at,
                 setup_status, setup_output, setup_started_at, setup_finished_at,
                 pokemon_number
          FROM worktrees
          WHERE project_id = ${projectId}
          ORDER BY created_at DESC
        `.pipe(Effect.orDie);
				return rows.map((row) => rowToWorktree(row, decoration.pokemonSummary));
			});

		const get: WorktreeService["Service"]["get"] = (worktreeId) =>
			Effect.gen(function* () {
				const rows = yield* sql<WorktreeRow>`
		  SELECT id, project_id, path, name, branch, branch_provenance, base_branch, created_at,
                 setup_status, setup_output, setup_started_at, setup_finished_at,
                 pokemon_number
          FROM worktrees
          WHERE id = ${worktreeId}
          LIMIT 1
        `.pipe(Effect.orDie);
				const row = rows[0];
				return row === undefined
					? null
					: rowToWorktree(row, decoration.pokemonSummary);
			});

		const updateBranch = (
			worktreeId: WorktreeId,
			branch: string,
			provenance: "automatic" | "manual" = "manual",
		): Effect.Effect<void> =>
			sql`
				UPDATE worktrees
				SET branch = ${branch}, branch_provenance = ${provenance}
				WHERE id = ${worktreeId}
			`.pipe(Effect.asVoid, Effect.orDie);

		const renameBranch: WorktreeService["Service"]["renameBranch"] = Effect.fn(
			"WorktreeService.renameBranch",
		)(function* (worktreeId, requestedName, provenance) {
			const rows = yield* sql<WorktreeRow>`
				SELECT id, project_id, path, name, branch, branch_provenance,
				       base_branch, created_at, setup_status, setup_output,
				       setup_started_at, setup_finished_at, pokemon_number
				FROM worktrees WHERE id = ${worktreeId} LIMIT 1
			`.pipe(Effect.orDie);
			const row = rows[0];
			if (row === undefined) {
				return yield* new WorktreeNotFoundError({ worktreeId });
			}
			if (provenance === "automatic" && row.branch_provenance !== "pending") {
				return rowToWorktree(row, decoration.pokemonSummary);
			}

			const fail = (reason: WorktreeBranchRenameReason, message: string) =>
				new WorktreeBranchRenameError({ worktreeId, reason, message });
			const requested = requestedName.trim();
			if (requested.length === 0) {
				return yield* fail("invalid", "Branch name cannot be empty.");
			}
			const current = (yield* runGit(row.path, [
				"branch",
				"--show-current",
			]).pipe(
				Effect.mapError((message) => fail("git-failed", message)),
			)).trim();
			if (current.length === 0) {
				return yield* fail("detached", "Cannot rename a detached HEAD.");
			}
			if (current !== row.branch) {
				yield* updateBranch(worktreeId, current, "manual");
				return yield* fail(
					"mismatch",
					`The branch changed outside the app to ${current}. It was reconciled; reopen rename to continue.`,
				);
			}
			if (current === requested) {
				yield* sql`
					UPDATE worktrees
					SET branch_provenance = ${provenance}
					WHERE id = ${worktreeId}
					  AND branch = ${current}
					  AND (${provenance} = 'manual' OR branch_provenance = 'pending')
				`.pipe(Effect.mapError((error) => fail("git-failed", String(error))));
				return (
					(yield* get(worktreeId)) ??
					rowToWorktree(row, decoration.pokemonSummary)
				);
			}

			yield* runGit(row.path, ["check-ref-format", "--branch", requested]).pipe(
				Effect.mapError((message) => fail("invalid", message)),
			);
			const upstream = (yield* runGit(row.path, [
				"rev-parse",
				"--abbrev-ref",
				"--symbolic-full-name",
				"@{upstream}",
			]).pipe(Effect.catch(() => Effect.succeed("")))).trim();
			const remoteBranches = (yield* runGit(row.path, [
				"branch",
				"--remotes",
				"--list",
				`*/${current}`,
			]).pipe(Effect.catch(() => Effect.succeed("")))).trim();
			const hasPullRequest = yield* runGh(row.path, [
				"pr",
				"view",
				"--json",
				"number",
			]).pipe(
				Effect.map(() => true),
				Effect.catch(() => Effect.succeed(false)),
			);
			if (upstream.length > 0 || remoteBranches.length > 0 || hasPullRequest) {
				return yield* fail(
					"published",
					"Published branches cannot be renamed. The remote branch and pull request were left unchanged.",
				);
			}

			const branchExists = (name: string) =>
				runGit(row.path, [
					"show-ref",
					"--verify",
					"--quiet",
					`refs/heads/${name}`,
				]).pipe(
					Effect.map(() => true),
					Effect.catch(() => Effect.succeed(false)),
				);
			let target = requested;
			if (yield* branchExists(target)) {
				if (provenance === "manual") {
					return yield* fail("conflict", `Branch ${target} already exists.`);
				}
				let suffix = 2;
				while (yield* branchExists(`${requested}-${suffix}`)) suffix += 1;
				target = `${requested}-${suffix}`;
			}

			yield* runGit(row.path, ["branch", "-m", current, target]).pipe(
				Effect.mapError((message) => fail("git-failed", message)),
			);
			const persisted = yield* sql<{ readonly id: string }>`
				UPDATE worktrees
				SET branch = ${target}, branch_provenance = ${provenance}
				WHERE id = ${worktreeId}
				  AND branch = ${current}
				  AND (${provenance} = 'manual' OR branch_provenance = 'pending')
				RETURNING id
			`.pipe(Effect.result);
			if (persisted._tag === "Failure" || persisted.success.length === 0) {
				const rollback = yield* runGit(row.path, [
					"branch",
					"-m",
					target,
					current,
				]).pipe(Effect.result);
				if (rollback._tag === "Failure") {
					return yield* fail(
						"rollback-failed",
						`Branch renamed to ${target}, but persistence and rollback failed.`,
					);
				}
				if (persisted._tag === "Success") {
					return yield* fail(
						"mismatch",
						"The worktree changed while the branch was being renamed. The Git rename was rolled back.",
					);
				}
				return yield* fail(
					"git-failed",
					"The branch rename could not be persisted and was rolled back.",
				);
			}
			const renamed = yield* get(worktreeId);
			if (renamed === null) {
				const rollback = yield* runGit(row.path, [
					"branch",
					"-m",
					target,
					current,
				]).pipe(Effect.result);
				if (rollback._tag === "Failure") {
					return yield* fail(
						"rollback-failed",
						`Branch renamed to ${target}, but the worktree disappeared and rollback failed.`,
					);
				}
				return yield* new WorktreeNotFoundError({ worktreeId });
			}
			return renamed;
		});

		const create: WorktreeService["Service"]["create"] = (projectId, source) =>
			Effect.gen(function* () {
				const folder = yield* projects.find(projectId);
				if (folder === null) {
					return yield* Effect.fail(
						new WorktreeCreateError({
							projectId,
							reason: "project not found",
						}),
					);
				}
				const repoPath = folder.path;
				const createSettings = yield* repositorySettings.get(projectId);
				// Layout: ~/.zuse/<repo-name>-<projectId-short>/<branch>/. Living
				// in the user's home dir (next to Downloads, Developer, etc.) keeps
				// the repo itself untouched — `git status`, file pickers, and any
				// tree walker stay clean. The projectId suffix disambiguates two
				// registered projects that happen to share a folder name.
				const baseDir =
					createSettings.worktreeBaseDir ??
					Path.join(
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
					]).pipe(Effect.result);

					let defaultBranch: string | null = null;
					if (symrefRaw._tag === "Success") {
						const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(
							symrefRaw.success,
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
								Effect.catch(() => Effect.succeed(false)),
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
					]).pipe(Effect.timeout(FETCH_TIMEOUT), Effect.result);
					if (fetched._tag === "Failure") {
						// runGit fails with a string; Effect.timeout adds a
						// TimeoutException — anything non-string is the timeout.
						const reason =
							typeof fetched.failure === "string"
								? fetched.failure
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
						Effect.catch(() => Effect.succeed(false)),
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
					const allocation = yield* nameAllocator.allocate({
						unavailableNames,
						usedPokemonNumbers,
					});
					if (allocation === null) break;
					const { name, pokemonNumber } = allocation;
					const branch = name;
					const target = Path.join(baseDir, name);

					const targetExists = yield* fs
						.exists(target)
						.pipe(Effect.catch(() => Effect.succeed(false)));
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
						Effect.catch(() => Effect.succeed(false)),
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
								Effect.catch(() => Effect.succeed(false)),
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
							]).pipe(Effect.result);
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
					}).pipe(Effect.result);
					if (addResult._tag === "Failure") {
						// Clean up a half-created worktree dir so the name can be retried.
						yield* runGit(repoPath, [
							"worktree",
							"remove",
							"--force",
							target,
						]).pipe(Effect.result);
						return yield* Effect.fail(
							new WorktreeCreateError({
								projectId,
								reason: addResult.failure,
							}),
						);
					}

					const id = WorktreeId.make(crypto.randomUUID());
					const now = yield* DateTime.nowAsDate;
					const nowIso = now.toISOString();
					yield* sql`
            INSERT INTO worktrees
              (id, project_id, path, name, branch, branch_provenance, base_branch, created_at,
               setup_status, setup_output, pokemon_number)
            VALUES
              (${id}, ${projectId}, ${target}, ${name}, ${checkedOutBranch}, ${source === undefined ? "pending" : "manual"}, ${baseBranch}, ${nowIso},
               'pending', '', ${pokemonNumber})
          `.pipe(Effect.orDie);
					yield* pokemonAssignment.record(pokemonNumber, id);
					// Setup runs detached so `create` returns as soon as the worktree +
					// branch exist. The renderer subscribes to `setupStream` to follow
					// setup live; the row starts `pending` and flips to `running` once
					// the forked setup begins.
					const created = yield* get(id);
					if (created === null) {
						return yield* new WorktreeCreateError({
							projectId,
							reason: "created worktree row could not be loaded",
						});
					}
					yield* Effect.forkDetach(runSetupSafely(id));
					return created;
				}
				return yield* Effect.fail(
					new WorktreeCreateError({
						projectId,
						reason: "could not pick a unique Pokémon worktree name",
					}),
				);
			});

		const checkpointCommitArgs = (worktreeId: WorktreeId) => [
			"commit",
			"-m",
			"zuse: archive checkpoint",
			"-m",
			`Zuse-Archive-Checkpoint: ${worktreeId}`,
			"--no-verify",
			"--no-gpg-sign",
		];

		const isMissingIdentity = (reason: string): boolean => {
			const lower = reason.toLowerCase();
			return (
				lower.includes("author identity unknown") ||
				lower.includes("please tell me who you are") ||
				lower.includes("unable to auto-detect email address")
			);
		};

		const moveDirectory = (source: string, destination: string) =>
			Effect.tryPromise({
				try: async () => {
					await makeDirectory(Path.dirname(destination), { recursive: true });
					try {
						await renamePath(source, destination);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
						await copyPath(source, destination, { recursive: true });
						await removePath(source, { recursive: true, force: true });
					}
				},
				catch: (error) =>
					error instanceof Error ? error.message : String(error),
			});

		const archivedContextDestination = (worktree: Worktree): string =>
			Path.join(Path.dirname(worktree.path), "archived", worktree.id);

		const deleteCheckoutAndRow = (
			row: Worktree,
			folderPath: string,
		): Effect.Effect<void, WorktreeRemoveError> =>
			Effect.gen(function* () {
				const gitRemoval = yield* runGit(folderPath, [
					"worktree",
					"remove",
					"--force",
					"--force",
					row.path,
				]).pipe(Effect.result);
				if (gitRemoval._tag === "Failure") {
					const fallback = yield* fs
						.remove(row.path, { recursive: true, force: true })
						.pipe(
							Effect.retry({
								times: 4,
								schedule: Schedule.exponential("50 millis"),
							}),
							Effect.result,
						);
					if (fallback._tag === "Failure") {
						return yield* Effect.fail(
							new WorktreeRemoveError({
								worktreeId: row.id,
								reason: `${gitRemoval.failure}; filesystem cleanup failed: ${fallback.failure.message}`,
							}),
						);
					}
				}
				yield* runGit(folderPath, ["worktree", "prune"]).pipe(
					Effect.mapError(
						(reason) => new WorktreeRemoveError({ worktreeId: row.id, reason }),
					),
				);
				const pathStillExists = yield* fs
					.exists(row.path)
					.pipe(Effect.orElseSucceed(() => false));
				if (pathStillExists) {
					return yield* Effect.fail(
						new WorktreeRemoveError({
							worktreeId: row.id,
							reason: `worktree path still exists after removal: ${row.path}`,
						}),
					);
				}
				yield* sql`DELETE FROM worktrees WHERE id = ${row.id}`.pipe(
					Effect.orDie,
				);
			});

		const checkpointAndDelete = Effect.fn(
			"WorktreeService.checkpointAndDelete",
		)(function* (
			worktreeId: WorktreeId,
			recordCheckpoint?: (
				outcome: WorktreeArchiveOutcome,
			) => Effect.Effect<void, WorktreeCheckpointError>,
			allowRemoval?: () => Effect.Effect<boolean>,
		) {
			const row = yield* get(worktreeId);
			if (row === null) {
				return yield* Effect.fail(new WorktreeNotFoundError({ worktreeId }));
			}
			const folder = yield* projects.find(row.projectId);
			if (folder === null) {
				return yield* Effect.fail(
					new WorktreeRemoveError({ worktreeId, reason: "project not found" }),
				);
			}
			const ensureRemovalAllowed =
				allowRemoval === undefined
					? Effect.void
					: allowRemoval().pipe(
							Effect.flatMap((allowed) =>
								allowed ? Effect.void : Effect.interrupt,
							),
						);

			const status = yield* runGit(row.path, ["status", "--porcelain"]).pipe(
				Effect.mapError(
					(reason) => new WorktreeCheckpointError({ worktreeId, reason }),
				),
			);
			let checkpointCreated = status.trim().length > 0;
			if (!checkpointCreated) {
				const currentBody = yield* runGit(row.path, [
					"show",
					"-s",
					"--format=%B",
					"HEAD",
				]).pipe(Effect.result);
				checkpointCreated =
					currentBody._tag === "Success" &&
					currentBody.success.includes(
						`Zuse-Archive-Checkpoint: ${worktreeId}`,
					);
			}
			if (status.trim().length > 0) {
				yield* ensureRemovalAllowed;
				yield* runGit(row.path, ["add", "-A"]).pipe(
					Effect.mapError(
						(reason) => new WorktreeCheckpointError({ worktreeId, reason }),
					),
				);
				const committed = yield* runGit(
					row.path,
					checkpointCommitArgs(worktreeId),
				).pipe(Effect.result);
				if (committed._tag === "Failure") {
					if (!isMissingIdentity(committed.failure)) {
						return yield* Effect.fail(
							new WorktreeCheckpointError({
								worktreeId,
								reason: committed.failure,
							}),
						);
					}
					yield* runGit(row.path, [
						"-c",
						"user.name=Zuse",
						"-c",
						"user.email=zuse@localhost",
						...checkpointCommitArgs(worktreeId),
					]).pipe(
						Effect.mapError(
							(reason) => new WorktreeCheckpointError({ worktreeId, reason }),
						),
					);
				}
			}

			const archiveCommit = (yield* runGit(row.path, [
				"rev-parse",
				"HEAD",
			]).pipe(
				Effect.mapError(
					(reason) => new WorktreeCheckpointError({ worktreeId, reason }),
				),
			)).trim();
			const symbolicBranch = yield* runGit(row.path, [
				"symbolic-ref",
				"--quiet",
				"--short",
				"HEAD",
			]).pipe(Effect.result);
			let archiveRef: string | null = null;
			if (symbolicBranch._tag === "Success") {
				const branch = symbolicBranch.success.trim();
				const branchCommit = (yield* runGit(folder.path, [
					"rev-parse",
					`refs/heads/${branch}`,
				]).pipe(
					Effect.mapError(
						(reason) => new WorktreeCheckpointError({ worktreeId, reason }),
					),
				)).trim();
				if (branchCommit !== archiveCommit) {
					return yield* Effect.fail(
						new WorktreeCheckpointError({
							worktreeId,
							reason: `branch ${branch} does not point at checkpoint ${archiveCommit}`,
						}),
					);
				}
			} else {
				archiveRef = `refs/zuse/archive/${worktreeId}`;
				yield* ensureRemovalAllowed;
				yield* runGit(folder.path, [
					"update-ref",
					archiveRef,
					archiveCommit,
				]).pipe(
					Effect.mapError(
						(reason) => new WorktreeCheckpointError({ worktreeId, reason }),
					),
				);
			}

			const contextSource = Path.join(row.path, ".context");
			const contextDestination = archivedContextDestination(row);
			const sourceExists = yield* fs
				.exists(contextSource)
				.pipe(Effect.orElseSucceed(() => false));
			let archivedContextPath: string | null = null;
			if (sourceExists) {
				const entries = yield* fs
					.readDirectory(contextSource)
					.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
				if (entries.length > 0) {
					const destinationExists = yield* fs
						.exists(contextDestination)
						.pipe(Effect.orElseSucceed(() => false));
					if (destinationExists) {
						return yield* Effect.fail(
							new WorktreeCheckpointError({
								worktreeId,
								reason: `archived context already exists: ${contextDestination}`,
							}),
						);
					}
					yield* ensureRemovalAllowed;
					yield* moveDirectory(contextSource, contextDestination).pipe(
						Effect.mapError(
							(reason) => new WorktreeCheckpointError({ worktreeId, reason }),
						),
					);
					archivedContextPath = contextDestination;
					const attachmentRewrite = yield* sql`
            UPDATE attachments
            SET abs_path = replace(abs_path, ${contextSource}, ${contextDestination})
            WHERE abs_path IS NOT NULL AND abs_path LIKE ${`${contextSource}/%`}
					`.pipe(Effect.result);
					if (attachmentRewrite._tag === "Failure") {
						yield* moveDirectory(contextDestination, contextSource).pipe(
							Effect.mapError(
								(rollbackReason) =>
									new WorktreeCheckpointError({
										worktreeId,
										reason: `attachment path update failed and context rollback failed: ${rollbackReason}`,
									}),
							),
						);
						return yield* Effect.fail(
							new WorktreeCheckpointError({
								worktreeId,
								reason: `attachment path update failed: ${String(attachmentRewrite.failure)}`,
							}),
						);
					}
				}
			} else {
				const destinationExists = yield* fs
					.exists(contextDestination)
					.pipe(Effect.orElseSucceed(() => false));
				if (destinationExists) archivedContextPath = contextDestination;
			}

			const outcome = {
				archiveCommit,
				checkpointCreated,
				archiveRef,
				archivedContextPath,
				branch: row.branch,
			} satisfies WorktreeArchiveOutcome;
			if (recordCheckpoint !== undefined) {
				const recorded = yield* recordCheckpoint(outcome).pipe(Effect.result);
				if (recorded._tag === "Failure") {
					if (archivedContextPath !== null) {
						yield* sql`
              UPDATE attachments
              SET abs_path = replace(abs_path, ${archivedContextPath}, ${contextSource})
              WHERE abs_path IS NOT NULL
                AND abs_path LIKE ${`${archivedContextPath}/%`}
            `.pipe(Effect.orDie);
						yield* moveDirectory(archivedContextPath, contextSource).pipe(
							Effect.mapError(
								(reason) => new WorktreeCheckpointError({ worktreeId, reason }),
							),
						);
					}
					return yield* Effect.fail(recorded.failure);
				}
			}

			if (allowRemoval !== undefined && !(yield* allowRemoval())) {
				if (archivedContextPath !== null) {
					yield* sql`
						UPDATE attachments
						SET abs_path = replace(abs_path, ${archivedContextPath}, ${contextSource})
						WHERE abs_path IS NOT NULL
						  AND abs_path LIKE ${`${archivedContextPath}/%`}
					`.pipe(Effect.orDie);
					yield* moveDirectory(archivedContextPath, contextSource).pipe(
						Effect.mapError(
							(reason) => new WorktreeCheckpointError({ worktreeId, reason }),
						),
					);
				}
				return { ...outcome, archivedContextPath: null };
			}
			yield* deleteCheckoutAndRow(row, folder.path);
			return outcome;
		});

		const archive: WorktreeService["Service"]["archive"] = checkpointAndDelete;
		const finishArchiveRemoval: WorktreeService["Service"]["finishArchiveRemoval"] =
			(worktreeId) =>
				Effect.gen(function* () {
					const row = yield* get(worktreeId);
					if (row === null) return;
					const folder = yield* projects.find(row.projectId);
					if (folder === null) {
						return yield* Effect.fail(
							new WorktreeRemoveError({
								worktreeId,
								reason: "project not found",
							}),
						);
					}
					yield* deleteCheckoutAndRow(row, folder.path);
				});
		const remove: WorktreeService["Service"]["remove"] = (worktreeId) =>
			checkpointAndDelete(worktreeId).pipe(Effect.asVoid);

		const restore: WorktreeService["Service"]["restore"] = (
			snapshot: WorktreeRestoreSnapshot,
		) =>
			Effect.gen(function* () {
				const folder = yield* projects.find(snapshot.projectId);
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
					.pipe(Effect.catch(() => Effect.succeed(false)));
				if (targetExists) {
					return yield* Effect.fail(
						new WorktreeRemoveError({
							worktreeId: snapshot.id,
							reason: `restore path already exists: ${snapshot.path}`,
						}),
					);
				}

				const restoreRef = snapshot.archiveRef ?? snapshot.branch;
				const branchExists = yield* runGit(folder.path, [
					"rev-parse",
					"--verify",
					"--quiet",
					snapshot.archiveRef ?? `refs/heads/${snapshot.branch}`,
				]).pipe(
					Effect.map(() => true),
					Effect.catch(() => Effect.succeed(false)),
				);
				if (!branchExists) {
					return yield* Effect.fail(
						new WorktreeRemoveError({
							worktreeId: snapshot.id,
							reason: `restore ref not found: ${restoreRef}`,
						}),
					);
				}

				const addArgs =
					snapshot.archiveRef === null || snapshot.archiveRef === undefined
						? ["worktree", "add", snapshot.path, snapshot.branch]
						: [
								"worktree",
								"add",
								"--detach",
								snapshot.path,
								snapshot.archiveRef,
							];
				const result = yield* runGit(folder.path, addArgs).pipe(Effect.result);
				if (result._tag === "Failure") {
					return yield* Effect.fail(
						new WorktreeRemoveError({
							worktreeId: snapshot.id,
							reason: result.failure,
						}),
					);
				}

				let shouldResetCheckpoint = false;
				if (
					snapshot.checkpointCreated &&
					snapshot.archiveCommit !== undefined
				) {
					const tip = (yield* runGit(snapshot.path, ["rev-parse", "HEAD"]).pipe(
						Effect.mapError(
							(reason) =>
								new WorktreeRemoveError({ worktreeId: snapshot.id, reason }),
						),
					)).trim();
					if (tip === snapshot.archiveCommit) {
						const body = yield* runGit(snapshot.path, [
							"show",
							"-s",
							"--format=%B",
							"HEAD",
						]).pipe(
							Effect.mapError(
								(reason) =>
									new WorktreeRemoveError({ worktreeId: snapshot.id, reason }),
							),
						);
						shouldResetCheckpoint = body.includes(
							`Zuse-Archive-Checkpoint: ${snapshot.id}`,
						);
					}
				}

				const archivedContextPath = snapshot.archivedContextPath ?? null;
				const restoredContextPath = Path.join(snapshot.path, ".context");
				let contextRestored = false;
				if (archivedContextPath !== null) {
					yield* moveDirectory(archivedContextPath, restoredContextPath).pipe(
						Effect.mapError(
							(reason) =>
								new WorktreeRemoveError({ worktreeId: snapshot.id, reason }),
						),
					);
					contextRestored = true;
					const attachmentRestore = yield* sql`
            UPDATE attachments
            SET abs_path = replace(abs_path, ${archivedContextPath}, ${restoredContextPath})
            WHERE abs_path IS NOT NULL
              AND abs_path LIKE ${`${archivedContextPath}/%`}
					`.pipe(Effect.result);
					if (attachmentRestore._tag === "Failure") {
						yield* moveDirectory(restoredContextPath, archivedContextPath).pipe(
							Effect.ignore,
						);
						yield* runGit(folder.path, [
							"worktree",
							"remove",
							"--force",
							"--force",
							snapshot.path,
						]).pipe(Effect.ignore);
						yield* runGit(folder.path, ["worktree", "prune"]).pipe(
							Effect.ignore,
						);
						return yield* Effect.fail(
							new WorktreeRemoveError({
								worktreeId: snapshot.id,
								reason: `attachment path update failed: ${String(attachmentRestore.failure)}`,
							}),
						);
					}
				}
				const rollbackRestore = Effect.gen(function* () {
					yield* sql`DELETE FROM worktrees WHERE id = ${snapshot.id}`.pipe(
						Effect.ignore,
					);
					if (contextRestored && archivedContextPath !== null) {
						yield* sql`
              UPDATE attachments
              SET abs_path = replace(abs_path, ${restoredContextPath}, ${archivedContextPath})
              WHERE abs_path IS NOT NULL
                AND abs_path LIKE ${`${restoredContextPath}/%`}
            `.pipe(Effect.ignore);
						yield* moveDirectory(restoredContextPath, archivedContextPath).pipe(
							Effect.ignore,
						);
					}
					yield* runGit(folder.path, [
						"worktree",
						"remove",
						"--force",
						"--force",
						snapshot.path,
					]).pipe(Effect.ignore);
					yield* runGit(folder.path, ["worktree", "prune"]).pipe(Effect.ignore);
				});

				const createdAtIso = snapshot.createdAt.toISOString();
				const inserted = yield* sql`
		  INSERT INTO worktrees
		    (id, project_id, path, name, branch, branch_provenance, base_branch, created_at,
             setup_status, setup_output)
          VALUES
            (${snapshot.id}, ${snapshot.projectId}, ${snapshot.path},
		     ${snapshot.name}, ${snapshot.branch}, 'manual', ${snapshot.baseBranch},
			     ${createdAtIso}, 'pending', '')
        `.pipe(Effect.result);
				if (inserted._tag === "Failure") {
					yield* rollbackRestore;
					return yield* Effect.fail(
						new WorktreeRemoveError({
							worktreeId: snapshot.id,
							reason: `worktree row restore failed: ${String(inserted.failure)}`,
						}),
					);
				}

				if (shouldResetCheckpoint) {
					const reset = yield* runGit(snapshot.path, [
						"reset",
						"--mixed",
						"HEAD~1",
					]).pipe(Effect.result);
					if (reset._tag === "Failure") {
						yield* rollbackRestore;
						return yield* Effect.fail(
							new WorktreeRemoveError({
								worktreeId: snapshot.id,
								reason: reset.failure,
							}),
						);
					}
				}

				if (snapshot.archiveRef !== null && snapshot.archiveRef !== undefined) {
					const deletedRef = yield* runGit(folder.path, [
						"update-ref",
						"-d",
						snapshot.archiveRef,
					]).pipe(Effect.result);
					if (deletedRef._tag === "Failure") {
						yield* rollbackRestore;
						return yield* Effect.fail(
							new WorktreeRemoveError({
								worktreeId: snapshot.id,
								reason: deletedRef.failure,
							}),
						);
					}
				}
				const restored = yield* get(snapshot.id);
				if (restored === null) {
					return yield* Effect.fail(
						new WorktreeRemoveError({
							worktreeId: snapshot.id,
							reason: "restored worktree row could not be loaded",
						}),
					);
				}
				yield* Effect.forkDetach(runSetupSafely(snapshot.id));
				return restored;
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

		const runSetupFor = Effect.fn("WorktreeService.runSetupFor")(function* (
			worktreeId: WorktreeId,
		) {
			const worktree = yield* get(worktreeId);
			if (worktree === null) {
				return yield* Effect.fail(new WorktreeNotFoundError({ worktreeId }));
			}
			const folder = yield* projects.find(worktree.projectId);
			if (folder === null) {
				return yield* Effect.fail(
					new WorktreeSetupError({ worktreeId, reason: "project not found" }),
				);
			}
			const settings = yield* repositorySettings.get(worktree.projectId);
			const script = settings.setupScript?.trim() ?? "";
			const startedAtDate = yield* DateTime.nowAsDate;
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
				emit(worktreeId, WorktreeSetupChunk.make({ worktreeId, output: prep }));
			}

			if (script.length === 0) {
				const finishedAtDate = yield* DateTime.nowAsDate;
				const finishedAt = finishedAtDate.toISOString();
				yield* sql`
            UPDATE worktrees
            SET setup_status = 'skipped',
                setup_output = ${prep},
                setup_finished_at = ${finishedAt}
            WHERE id = ${worktreeId}
          `.pipe(Effect.orDie);
				emitStatus(worktreeId, "skipped", startedAtDate, finishedAtDate);
				const updated = yield* get(worktreeId);
				return updated === null
					? yield* new WorktreeSetupError({
							worktreeId,
							reason: "setup worktree row could not be loaded",
						})
					: updated;
			}

			const result = yield* runShellScript({
				script,
				cwd: worktree.path,
				env: setupEnv(folder.path, worktree, settings.environmentVariables),
				onData: (acc) =>
					emit(
						worktreeId,
						WorktreeSetupChunk.make({
							worktreeId,
							output: truncateOutput(`${prep}${acc}`),
						}),
					),
			}).pipe(
				Effect.mapError(
					(err) =>
						new WorktreeSetupError({
							worktreeId,
							reason: err instanceof Error ? err.message : String(err),
						}),
				),
			);
			const finishedAtDate = yield* DateTime.nowAsDate;
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
			const updated = yield* get(worktreeId);
			return updated === null
				? yield* new WorktreeSetupError({
						worktreeId,
						reason: "setup worktree row could not be loaded",
					})
				: updated;
		});

		/**
		 * Run setup and guarantee a terminal status is always persisted + emitted
		 * — even when setup throws — so a `setupStream` never hangs in `running`.
		 */
		const runSetupSafely = (worktreeId: WorktreeId): Effect.Effect<void> =>
			runSetupFor(worktreeId).pipe(
				Effect.asVoid,
				Effect.catch((err) =>
					Effect.gen(function* () {
						const finishedAt = yield* DateTime.nowAsDate;
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

		const rerunSetup: WorktreeService["Service"]["rerunSetup"] = (worktreeId) =>
			Effect.gen(function* () {
				const wt = yield* get(worktreeId);
				if (wt === null) {
					return yield* Effect.fail(new WorktreeNotFoundError({ worktreeId }));
				}
				// Same non-blocking model as `create`: kick off setup detached and
				// return immediately; the renderer follows via `setupStream`.
				yield* Effect.forkDetach(runSetupSafely(worktreeId));
				return wt;
			});

		const setupStream: WorktreeService["Service"]["setupStream"] = (
			worktreeId,
		) =>
			Stream.unwrap(
				Effect.gen(function* () {
					const wt = yield* get(worktreeId);
					if (wt === null) {
						return Stream.fail(new WorktreeNotFoundError({ worktreeId }));
					}
					const mailbox = yield* Queue.make<WorktreeSetupEvent, Cause.Done>();
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
					Queue.offerUnsafe(
						mailbox,
						WorktreeSetupChunk.make({
							worktreeId,
							output: wt.setupOutput,
						}),
					);
					Queue.offerUnsafe(
						mailbox,
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
						Queue.endUnsafe(mailbox);
					}
					return Stream.fromQueue(mailbox);
				}),
			);

		const startRun: WorktreeService["Service"]["startRun"] = (worktreeId) =>
			Effect.gen(function* () {
				const worktree = yield* get(worktreeId);
				if (worktree === null) {
					return yield* Effect.fail(new WorktreeNotFoundError({ worktreeId }));
				}
				const folder = yield* projects.find(worktree.projectId);
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
			renameBranch,
			archive,
			finishArchiveRemoval,
			remove,
			restore,
			rerunSetup,
			setupStream,
			startRun,
		} as const;
	}),
);
