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
	WorktreeRestoreError,
	WorktreeSetupChunk,
	WorktreeSetupError,
	type WorktreeSetupEvent,
	type WorktreeSetupStatus,
	WorktreeSetupStatusEvent,
} from "@zuse/contracts";
import { shellCommandForPlatform } from "@zuse/utils/shell-command";
import {
	type Cause,
	DateTime,
	Deferred,
	Effect,
	FileSystem,
	Layer,
	Queue,
	Schedule,
	Semaphore,
	Stream,
} from "effect";
import {
	ChildProcess as Command,
	ChildProcessSpawner as CommandExecutor,
} from "effect/unstable/process";
import { SqlClient } from "effect/unstable/sql";
import {
	checkpointRefFromGitError,
	recoverGitCheckpointRef,
} from "../checkpoints.ts";
import { parseRemoteUrl, resolveGitHubRepository } from "../git-remote.ts";
import {
	GitHubClient,
	GitHubClientService,
	GitHubFailure,
	githubExecutionEnvironment,
} from "../github-client.ts";
import { GitHubPullRequests } from "../github-pull-requests.ts";
import {
	ARCHIVE_CHECKPOINT_MESSAGE,
	archiveCheckpointTrailer,
	archiveRefForWorktree,
} from "./archive-constants.ts";
import { linkIncludedFiles } from "./env-files.ts";
import {
	PokemonAssignment,
	ProjectLocator,
	RepositorySettingsReader,
	WorktreeDecoration,
	WorktreeNameAllocator,
} from "./ports.ts";
import { mergeArchivedContext } from "./restore-context.ts";
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

const FETCH_TIMEOUT = "5 seconds" as const;

const REMOTE_BASE_REUSE_MS = 60_000;

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
const SETUP_STARTED_MESSAGE = "Running setup script...\n";
const SETUP_INTERRUPTED_MESSAGE =
	"Setup was interrupted when Zuse stopped. Retry setup to continue.\n";
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

export { shellCommandForPlatform } from "@zuse/utils/shell-command";

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

const isSymbolicLink = async (path: string): Promise<boolean> => {
	try {
		return (await fs.lstat(path)).isSymbolicLink();
	} catch {
		return false;
	}
};

const prepareLocalFiles = async (
	repoPath: string,
	worktreePath: string,
	includeGlobs: string,
): Promise<{
	readonly output: string;
	readonly sharesNodeModules: boolean;
}> => {
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

	return {
		output,
		sharesNodeModules: await isSymbolicLink(targetNodeModules),
	};
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
		const providedGitHub = yield* GitHubClientService;
		const github = providedGitHub ?? new GitHubClient();
		const pullRequests = new GitHubPullRequests(github);
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				pullRequests.close();
				if (!providedGitHub) github.close();
			}),
		);
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
						const shell = shellCommandForPlatform(
							process.platform,
							process.env,
						);
						const command = Command.make(
							shell.command,
							[...shell.args, script],
							{
								cwd,
								env: { ...env },
								extendEnv: true,
								stdin: "ignore",
							},
						);
						const childProcess = yield* executor.spawn(command);
						const output = yield* childProcess.all.pipe(
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
						const exitCode = yield* childProcess.exitCode;
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

		// A setup child cannot survive the desktop host that launched it. Mark any
		// persisted `running` rows terminal during startup so a previous crash or
		// forced dev restart cannot leave the UI waiting forever.
		const recoveredAt = (yield* DateTime.nowAsDate).toISOString();
		yield* sql`
			UPDATE worktrees
			SET setup_status = 'failed',
				setup_output = CASE
					WHEN trim(setup_output) = '' THEN ${SETUP_INTERRUPTED_MESSAGE}
					ELSE setup_output || ${`\n${SETUP_INTERRUPTED_MESSAGE}`}
				END,
				setup_finished_at = ${recoveredAt}
			WHERE setup_status = 'running'
		`.pipe(Effect.orDie);

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

		const runGitOnce = (
			cwd: string,
			args: ReadonlyArray<string>,
			env?: Readonly<Record<string, string>>,
		) =>
			Effect.scoped(
				Effect.gen(function* () {
					const cmd = Command.make("git", args, {
						cwd,
						env: {
							...(yield* githubExecutionEnvironment.pipe(
								Effect.mapError((error) => error.message),
							)),
							...env,
						},
						extendEnv: true,
					});
					const proc = yield* executor.spawn(cmd);
					const [stdout, stderr] = yield* Effect.all(
						[collectText(proc.stdout), collectText(proc.stderr)],
						{ concurrency: 2 },
					);
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

		const runGit = Effect.fn("WorktreeService.runGit")(function* (
			cwd: string,
			args: ReadonlyArray<string>,
			env?: Readonly<Record<string, string>>,
		) {
			const recoveredRefs = new Set<string>();
			for (;;) {
				const result = yield* runGitOnce(cwd, args, env).pipe(Effect.result);
				if (result._tag === "Success") return result.success;
				const ref =
					args[0] === "fetch"
						? checkpointRefFromGitError(result.failure)
						: null;
				if (ref === null || recoveredRefs.has(ref))
					return yield* Effect.fail(result.failure);
				const recovered = yield* Effect.tryPromise({
					try: (signal) => recoverGitCheckpointRef(cwd, result.failure, signal),
					catch: (error) =>
						`${result.failure}\nCheckpoint recovery failed: ${error instanceof Error ? error.message : String(error)}`,
				});
				if (!recovered) return yield* Effect.fail(result.failure);
				recoveredRefs.add(ref);
				yield* Effect.logWarning(
					"Quarantined an invalid Zuse checkpoint reference; retrying Git fetch. Evidence is retained in the repository's zuse/checkpoint-recovery directory.",
				);
			}
		});

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
			const repository = yield* resolveGitHubRepository(row.path, (args) =>
				runGit(row.path, args),
			).pipe(Effect.mapError((message) => fail("git-failed", message)));
			const hasPullRequest = repository
				? yield* Effect.tryPromise({
						try: (signal) =>
							pullRequests.discover(
								repository,
								current,
								signal,
								true,
								true,
								repository.owner,
							),
						catch: (error) => error,
					}).pipe(
						Effect.map((number) => number !== null),
						Effect.catch((error) =>
							error instanceof GitHubFailure &&
							(error.kind === "authentication" || error.kind === "offline")
								? Effect.succeed(false)
								: Effect.fail(
										fail(
											"git-failed",
											error instanceof GitHubFailure
												? error.message
												: "Could not verify GitHub branch state.",
										),
									),
						),
					)
				: false;
			// A fresh worktree branch is created from origin/<base> and Git may
			// automatically retain that base as its upstream. That does not mean
			// the temporary branch itself was published. Only another upstream,
			// a same-named remote ref, or a pull request makes renaming unsafe.
			const baseName = row.base_branch
				.replace(/^refs\/remotes\//, "")
				.replace(/^origin\//, "");
			const tracksRemoteBase = upstream === `origin/${baseName}`;
			if (
				(upstream.length > 0 && !tracksRemoteBase) ||
				remoteBranches.length > 0 ||
				hasPullRequest
			) {
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

		const create: WorktreeService["Service"]["create"] = (
			projectId,
			source,
			requestedId,
		) =>
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
				if (requestedId !== undefined) {
					const interrupted = yield* get(requestedId);
					if (interrupted !== null) {
						const validCheckout = yield* runGit(interrupted.path, [
							"rev-parse",
							"--is-inside-work-tree",
						]).pipe(
							Effect.map((value) => value.trim() === "true"),
							Effect.catch(() => Effect.succeed(false)),
						);
						if (validCheckout) {
							if (interrupted.setupStatus === "pending") {
								yield* Effect.forkDetach(runSetupSafely(requestedId));
							}
							return interrupted;
						}
						yield* runGit(repoPath, [
							"worktree",
							"remove",
							"--force",
							interrupted.path,
						]).pipe(Effect.result);
						yield* Effect.promise(() =>
							removePath(interrupted.path, {
								recursive: true,
								force: true,
							}),
						).pipe(Effect.result);
						if (interrupted.branchProvenance === "pending") {
							yield* runGit(repoPath, [
								"branch",
								"-D",
								interrupted.branch,
							]).pipe(Effect.result);
						}
						yield* sql`
							DELETE FROM worktrees WHERE id = ${requestedId}
						`.pipe(Effect.orDie);
					}
				}
				const createSettings = yield* repositorySettings.get(projectId);

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
					const headRefRaw = yield* runGit(repoPath, [
						"rev-parse",
						"--abbrev-ref",
						"HEAD",
					]).pipe(Effect.mapError(fail));
					baseBranch = headRefRaw.trim() || "HEAD";
					baseRef = "HEAD";
				} else {
					const remoteStartedAt = Date.now();
					const remoteBase = yield* refreshRemoteBase(projectId, repoPath);
					yield* Effect.logInfo(
						`[chat-creation-timing] project=${projectId} remote_fetch_ms=${Date.now() - remoteStartedAt}`,
					);
					baseBranch = remoteBase.baseBranch;
					baseRef = remoteBase.baseRef;
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

					let checkedOutBranch = branch;
					const id = requestedId ?? WorktreeId.make(crypto.randomUUID());
					const now = yield* DateTime.nowAsDate;
					const nowIso = now.toISOString();
					const journalBeforeCheckout =
						requestedId !== undefined && source === undefined;
					if (journalBeforeCheckout) {
						yield* sql`
							INSERT INTO worktrees
								(id, project_id, path, name, branch, branch_provenance, base_branch, created_at,
								 setup_status, setup_output, pokemon_number)
							VALUES
								(${id}, ${projectId}, ${target}, ${name}, ${branch}, 'pending', ${baseBranch}, ${nowIso},
								 'pending', '', ${pokemonNumber})
						`.pipe(Effect.orDie);
					}
					const checkoutStartedAt = Date.now();
					const addResult = yield* Effect.gen(function* () {
						if (source === undefined) {
							const output = yield* runGit(repoPath, [
								"worktree",
								"add",
								"-b",
								branch,
								target,
								baseRef,
							]);
							if (hasOrigin)
								yield* runGit(target, [
									"-c",
									`remote.origin.fetch=+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
									"branch",
									"--set-upstream-to",
									`origin/${baseBranch}`,
									branch,
								]);
							return output;
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
								return yield* runGit(repoPath, [
									"worktree",
									"add",
									target,
									source.branch,
								]);
							}

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
						const repository = yield* resolveGitHubRepository(
							repoPath,
							(args) => runGit(repoPath, args),
						);
						if (!repository)
							return yield* Effect.fail(
								"No GitHub repository is available for this pull request.",
							);
						const pr = yield* Effect.tryPromise({
							try: (signal) =>
								pullRequests.read(repository, source.number, signal, {
									force: true,
								}),
							catch: (error) =>
								error instanceof GitHubFailure
									? error.message
									: "Could not read the pull request.",
						});
						const defaultBranch = pr.headRepository?.defaultBranchRef?.name;
						checkedOutBranch =
							pr.isCrossRepository &&
							(pr.headRefName === defaultBranch ||
								pr.headRefName === pr.baseRefName)
								? `${pr.headRepositoryOwner?.login ?? "fork"}/${pr.headRefName}`
								: pr.headRefName;
						yield* runGit(repoPath, [
							"check-ref-format",
							"--branch",
							checkedOutBranch,
						]);
						let remoteName = "origin";
						const remoteNames = (yield* runGit(repoPath, ["remote"]))
							.trim()
							.split("\n");
						const headRepository = pr.headRepository?.nameWithOwner;
						let found = false;
						for (const candidate of remoteNames) {
							const remote = parseRemoteUrl(
								(yield* runGit(repoPath, [
									"remote",
									"get-url",
									candidate,
								])).trim(),
							);
							if (
								remote?.host === repository.host &&
								`${remote.owner}/${remote.repo}`.toLowerCase() ===
									headRepository?.toLowerCase()
							) {
								remoteName = candidate;
								found = true;
								break;
							}
						}
						if (!found && pr.headRepository) {
							remoteName = pr.headRepositoryOwner?.login ?? "fork";
							if (remoteNames.includes(remoteName))
								remoteName = `pr-${source.number}-${remoteName}`;
							yield* runGit(repoPath, [
								"remote",
								"add",
								remoteName,
								`${pr.headRepository.url}.git`,
							]);
							found = true;
						}

						if (found)
							yield* runGit(repoPath, [
								"fetch",
								remoteName,
								`+refs/heads/${pr.headRefName}:refs/remotes/${remoteName}/${pr.headRefName}`,
							]);
						else
							yield* runGit(repoPath, [
								"fetch",
								`https://${repository.host}/${repository.owner}/${repository.repo}.git`,
								`refs/pull/${source.number}/head`,
							]);
						const ref = found
							? `${remoteName}/${pr.headRefName}`
							: "FETCH_HEAD";
						const fetched = (yield* runGit(repoPath, [
							"rev-parse",
							ref,
						])).trim();
						if (fetched !== pr.headRefOid)
							return yield* Effect.fail(
								"The pull request changed during checkout. Retry to use its current head.",
							);
						const localExists = yield* runGit(repoPath, [
							"show-ref",
							"--verify",
							`refs/heads/${checkedOutBranch}`,
						]).pipe(
							Effect.as(true),
							Effect.catch(() => Effect.succeed(false)),
						);
						if (localExists) {
							yield* runGit(repoPath, [
								"worktree",
								"add",
								target,
								checkedOutBranch,
							]);
							yield* runGit(target, ["merge", "--ff-only", ref]);
						} else
							yield* runGit(repoPath, [
								"worktree",
								"add",
								"-b",
								checkedOutBranch,
								target,
								ref,
							]);
						if (found)
							yield* runGit(target, [
								"branch",
								"--set-upstream-to",
								`${remoteName}/${pr.headRefName}`,
								checkedOutBranch,
							]);
						return "";
					}).pipe(Effect.result);
					yield* Effect.logInfo(
						`[chat-creation-timing] project=${projectId} checkout_create_ms=${Date.now() - checkoutStartedAt}`,
					);
					if (addResult._tag === "Failure") {
						yield* runGit(repoPath, [
							"worktree",
							"remove",
							"--force",
							target,
						]).pipe(Effect.result);
						if (journalBeforeCheckout) {
							yield* sql`
								DELETE FROM worktrees WHERE id = ${id}
							`.pipe(Effect.orDie);
						}
						return yield* Effect.fail(
							new WorktreeCreateError({
								projectId,
								reason: addResult.failure,
							}),
						);
					}

					if (!journalBeforeCheckout) {
						yield* sql`
							INSERT INTO worktrees
								(id, project_id, path, name, branch, branch_provenance, base_branch, created_at,
								 setup_status, setup_output, pokemon_number)
							VALUES
								(${id}, ${projectId}, ${target}, ${name}, ${checkedOutBranch}, ${source === undefined ? "pending" : "manual"}, ${baseBranch}, ${nowIso},
								 'pending', '', ${pokemonNumber})
						`.pipe(Effect.orDie);
					}
					yield* pokemonAssignment.record(pokemonNumber, id);

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

		type RemoteBase = {
			readonly baseBranch: string;
			readonly baseRef: string;
		};
		const remoteRefreshes = new Map<
			string,
			Deferred.Deferred<RemoteBase, WorktreeCreateError>
		>();
		const recentRemoteBases = new Map<
			string,
			{ readonly base: RemoteBase; readonly refreshedAt: number }
		>();
		const remoteRefreshLock = yield* Semaphore.make(1);
		const refreshRemoteBase = (
			projectId: FolderId,
			repoPath: string,
		): Effect.Effect<RemoteBase, WorktreeCreateError> =>
			Effect.gen(function* () {
				const acquired = yield* remoteRefreshLock.withPermits(1)(
					Effect.gen(function* () {
						const recent = recentRemoteBases.get(repoPath);
						if (
							recent !== undefined &&
							Date.now() - recent.refreshedAt < REMOTE_BASE_REUSE_MS
						) {
							return { recent: recent.base } as const;
						}
						const existing = remoteRefreshes.get(repoPath);
						if (existing !== undefined) {
							return { deferred: existing, owner: false } as const;
						}
						const deferred = yield* Deferred.make<
							RemoteBase,
							WorktreeCreateError
						>();
						remoteRefreshes.set(repoPath, deferred);
						return { deferred, owner: true } as const;
					}),
				);
				if (acquired.recent !== undefined) return acquired.recent;
				if (acquired.owner) {
					const fail = (reason: string) =>
						new WorktreeCreateError({ projectId, reason });
					const refresh: Effect.Effect<RemoteBase, WorktreeCreateError> =
						Effect.gen(function* () {
							const fetchBranch = (branch: string) =>
								runGit(repoPath, [
									"fetch",
									"--no-tags",
									"origin",
									`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
								]).pipe(Effect.timeout(FETCH_TIMEOUT), Effect.result);

							const localHead = (yield* runGit(repoPath, [
								"symbolic-ref",
								"--quiet",
								"--short",
								"refs/remotes/origin/HEAD",
							]).pipe(Effect.orElseSucceed(() => ""))).trim();
							const recordedDefault =
								localHead.startsWith("origin/") &&
								localHead.length > "origin/".length
									? localHead.slice("origin/".length)
									: null;
							const [symrefRaw, recordedFetch] = yield* Effect.all(
								[
									runGit(repoPath, [
										"ls-remote",
										"--symref",
										"origin",
										"HEAD",
									]).pipe(Effect.timeout(FETCH_TIMEOUT), Effect.result),
									recordedDefault === null
										? Effect.succeed(null)
										: fetchBranch(recordedDefault),
								],
								{ concurrency: 2 },
							);
							let defaultBranch: string | null = recordedDefault;
							if (symrefRaw._tag === "Success") {
								const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(
									symrefRaw.success,
								);
								defaultBranch = match?.[1] ?? defaultBranch;
							}
							if (defaultBranch === null) {
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
							const fetched =
								defaultBranch === recordedDefault && recordedFetch !== null
									? recordedFetch
									: yield* fetchBranch(defaultBranch);
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
										`origin/${defaultBranch} not found after fetch — cannot create worktree${fetched._tag === "Failure" ? `: ${String(fetched.failure)}` : ""}`,
									),
								);
							}
							if (fetched._tag === "Failure") {
								const reason =
									typeof fetched.failure === "string"
										? fetched.failure
										: `timed out after ${FETCH_TIMEOUT}`;
								yield* Effect.logWarning(
									`Could not refresh origin/${defaultBranch}; creating workspace from its cached remote-tracking branch: ${reason}`,
								);
							}
							const base = {
								baseBranch: defaultBranch,
								baseRef: (yield* runGit(repoPath, [
									"rev-parse",
									"--verify",
									`refs/remotes/origin/${defaultBranch}^{commit}`,
								]).pipe(Effect.mapError(fail))).trim(),
							};
							recentRemoteBases.set(repoPath, {
								base,
								refreshedAt: Date.now(),
							});
							return base;
						});
					yield* refresh.pipe(
						Effect.matchEffect({
							onFailure: (error) => Deferred.fail(acquired.deferred, error),
							onSuccess: (value) => Deferred.succeed(acquired.deferred, value),
						}),
						Effect.ensuring(
							Effect.sync(() => remoteRefreshes.delete(repoPath)),
						),
						Effect.forkDetach,
					);
				}
				return yield* Deferred.await(acquired.deferred);
			});

		const checkpointCommitTreeArgs = (tree: string, worktreeId: WorktreeId) => [
			"commit-tree",
			tree,
			"-p",
			"HEAD",
			"-m",
			ARCHIVE_CHECKPOINT_MESSAGE,
			"-m",
			archiveCheckpointTrailer(worktreeId),
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
			let archiveRef: string | null = null;
			let archiveCommit: string;
			if (checkpointCreated) {
				const checkpointRef = archiveRefForWorktree(worktreeId);
				archiveRef = checkpointRef;
				const temporaryIndex = Path.join(
					os.tmpdir(),
					`zuse-archive-index-${worktreeId}-${crypto.randomUUID()}`,
				);
				const indexEnv = { GIT_INDEX_FILE: temporaryIndex };
				archiveCommit = yield* Effect.gen(function* () {
					yield* runGit(row.path, ["read-tree", "HEAD"], indexEnv);
					yield* runGit(row.path, ["add", "-A"], indexEnv);
					const tree = (yield* runGit(
						row.path,
						["write-tree"],
						indexEnv,
					)).trim();
					const existingCommit = yield* runGit(folder.path, [
						"rev-parse",
						"--verify",
						"--quiet",
						checkpointRef,
					]).pipe(Effect.result);
					if (existingCommit._tag === "Success") {
						const existing = existingCommit.success.trim();
						const [existingTree, existingParent, head, body] =
							yield* Effect.all([
								runGit(folder.path, ["rev-parse", `${existing}^{tree}`]),
								runGit(folder.path, ["rev-parse", `${existing}^`]),
								runGit(row.path, ["rev-parse", "HEAD"]),
								runGit(folder.path, ["show", "-s", "--format=%B", existing]),
							]);
						if (
							existingTree.trim() === tree &&
							existingParent.trim() === head.trim() &&
							body.includes(archiveCheckpointTrailer(worktreeId))
						) {
							return existing;
						}
					}
					const commitArgs = checkpointCommitTreeArgs(tree, worktreeId);
					let committed = yield* runGit(row.path, commitArgs).pipe(
						Effect.result,
					);
					if (
						committed._tag === "Failure" &&
						isMissingIdentity(committed.failure)
					) {
						committed = yield* runGit(row.path, [
							"-c",
							"user.name=Zuse",
							"-c",
							"user.email=zuse@localhost",
							...commitArgs,
						]).pipe(Effect.result);
					}
					if (committed._tag === "Failure") {
						return yield* Effect.fail(committed.failure);
					}
					const commit = committed.success.trim();
					yield* runGit(folder.path, ["update-ref", checkpointRef, commit]);
					return commit;
				}).pipe(
					Effect.mapError(
						(reason) => new WorktreeCheckpointError({ worktreeId, reason }),
					),
					Effect.ensuring(
						Effect.sync(() => {
							fsSync.rmSync(temporaryIndex, { force: true });
							fsSync.rmSync(`${temporaryIndex}.lock`, { force: true });
						}),
					),
				);
			} else {
				const currentBody = yield* runGit(row.path, [
					"show",
					"-s",
					"--format=%B",
					"HEAD",
				]).pipe(Effect.result);
				checkpointCreated =
					currentBody._tag === "Success" &&
					currentBody.success.includes(archiveCheckpointTrailer(worktreeId));
				archiveCommit = (yield* runGit(row.path, ["rev-parse", "HEAD"]).pipe(
					Effect.mapError(
						(reason) => new WorktreeCheckpointError({ worktreeId, reason }),
					),
				)).trim();
			}
			yield* ensureRemovalAllowed;
			const symbolicBranch = yield* runGit(row.path, [
				"symbolic-ref",
				"--quiet",
				"--short",
				"HEAD",
			]).pipe(Effect.result);
			if (archiveRef === null && symbolicBranch._tag === "Success") {
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
			} else if (archiveRef === null) {
				archiveRef = archiveRefForWorktree(worktreeId);
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
				branch:
					symbolicBranch._tag === "Success"
						? symbolicBranch.success.trim()
						: row.branch,
				detachedHead: symbolicBranch._tag === "Failure",
				branchProvenance: row.branchProvenance,
				pokemonNumber: row.pokemon?.number ?? null,
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
		const remove: WorktreeService["Service"]["remove"] = (worktreeId) =>
			checkpointAndDelete(worktreeId).pipe(
				Effect.tap((outcome) =>
					outcome.archiveRef === null
						? Effect.void
						: Effect.logWarning(
								`Removed worktree ${worktreeId}; archived changes remain at ${outcome.archiveRef}`,
							),
				),
				Effect.asVoid,
			);

		const restore: WorktreeService["Service"]["restore"] = (
			snapshot: WorktreeRestoreSnapshot,
		) =>
			Effect.gen(function* () {
				const failRestore = (reason: string) =>
					new WorktreeRestoreError({ worktreeId: snapshot.id, reason });
				const folder = yield* projects.find(snapshot.projectId);
				if (folder === null) {
					return yield* Effect.fail(failRestore("project not found"));
				}

				yield* runGit(folder.path, ["worktree", "prune"]).pipe(
					Effect.mapError(failRestore),
				);
				const existing = yield* get(snapshot.id);
				if (existing !== null) {
					const existingPathExists = yield* fs
						.exists(existing.path)
						.pipe(Effect.orElseSucceed(() => false));
					if (existingPathExists) {
						return {
							worktree: existing,
							checkpoint: "already-present" as const,
						};
					}
					yield* sql`DELETE FROM worktrees WHERE id = ${snapshot.id}`.pipe(
						Effect.mapError((error) =>
							failRestore(
								`stale worktree row cleanup failed: ${String(error)}`,
							),
						),
					);
				}

				const targetExists = yield* fs
					.exists(snapshot.path)
					.pipe(Effect.catch(() => Effect.succeed(false)));
				if (targetExists) {
					return yield* Effect.fail(
						failRestore(`restore path already exists: ${snapshot.path}`),
					);
				}

				const checkpointRef = archiveRefForWorktree(snapshot.id);
				const checkpointProbe = yield* runGit(folder.path, [
					"rev-parse",
					"--verify",
					"--quiet",
					checkpointRef,
				]).pipe(Effect.result);
				let checkpointCommit: string | null = null;
				let checkpointParent: string | null = null;
				if (checkpointProbe._tag === "Success") {
					const candidate = checkpointProbe.success.trim();
					const [body, parent] = yield* Effect.all([
						runGit(folder.path, ["show", "-s", "--format=%B", candidate]),
						runGit(folder.path, ["rev-parse", `${candidate}^`]),
					]).pipe(Effect.mapError(failRestore));
					if (body.includes(archiveCheckpointTrailer(snapshot.id))) {
						checkpointCommit = candidate;
						checkpointParent = parent.trim();
					}
				}

				const branchExists = yield* runGit(folder.path, [
					"rev-parse",
					"--verify",
					"--quiet",
					`refs/heads/${snapshot.branch}`,
				]).pipe(
					Effect.map(() => true),
					Effect.catch(() => Effect.succeed(false)),
				);
				const branchTip = branchExists
					? (yield* runGit(folder.path, [
							"rev-parse",
							`refs/heads/${snapshot.branch}`,
						]).pipe(Effect.mapError(failRestore))).trim()
					: null;

				let checkpoint: "applied" | "none" | "branch-advanced" = "none";
				let applyIsolatedCheckpoint = false;
				let resetLegacyCheckpoint = false;
				let addArgs: ReadonlyArray<string>;
				if (checkpointCommit !== null && checkpointParent !== null) {
					if (snapshot.detachedHead === true || !branchExists) {
						addArgs = [
							"worktree",
							"add",
							"--detach",
							snapshot.path,
							checkpointParent,
						];
						applyIsolatedCheckpoint = true;
					} else if (branchTip === checkpointParent) {
						addArgs = ["worktree", "add", snapshot.path, snapshot.branch];
						applyIsolatedCheckpoint = true;
					} else {
						addArgs = ["worktree", "add", snapshot.path, snapshot.branch];
						checkpoint = "branch-advanced";
					}
				} else if (branchExists) {
					addArgs = ["worktree", "add", snapshot.path, snapshot.branch];
					if (
						snapshot.archiveRef == null &&
						snapshot.checkpointCreated === true &&
						snapshot.archiveCommit !== undefined &&
						branchTip === snapshot.archiveCommit
					) {
						const body = yield* runGit(folder.path, [
							"show",
							"-s",
							"--format=%B",
							branchTip,
						]).pipe(Effect.mapError(failRestore));
						resetLegacyCheckpoint = body.includes(
							archiveCheckpointTrailer(snapshot.id),
						);
					}
				} else if (snapshot.archiveCommit !== undefined) {
					addArgs = [
						"worktree",
						"add",
						"--detach",
						snapshot.path,
						snapshot.archiveCommit,
					];
				} else {
					return yield* Effect.fail(
						failRestore(`restore branch not found: ${snapshot.branch}`),
					);
				}

				const result = yield* runGit(folder.path, addArgs).pipe(Effect.result);
				if (result._tag === "Failure") {
					return yield* Effect.fail(failRestore(result.failure));
				}
				const rollbackCheckout = Effect.gen(function* () {
					if (resetLegacyCheckpoint && snapshot.archiveCommit !== undefined) {
						yield* runGit(snapshot.path, [
							"reset",
							"--hard",
							snapshot.archiveCommit,
						]).pipe(Effect.ignore);
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

				const materialized = yield* Effect.gen(function* () {
					if (applyIsolatedCheckpoint && checkpointCommit !== null) {
						yield* runGit(snapshot.path, [
							"read-tree",
							"-m",
							"-u",
							"HEAD",
							checkpointCommit,
						]);
						yield* runGit(snapshot.path, ["reset", "--mixed", "HEAD"]);
						checkpoint = "applied";
					} else if (resetLegacyCheckpoint) {
						yield* runGit(snapshot.path, ["reset", "--mixed", "HEAD~1"]);
						checkpoint = "applied";
					}
				}).pipe(Effect.mapError(failRestore), Effect.result);
				if (materialized._tag === "Failure") {
					yield* rollbackCheckout;
					return yield* Effect.fail(materialized.failure);
				}

				const archivedContextPath = snapshot.archivedContextPath ?? null;
				const restoredContextPath = Path.join(snapshot.path, ".context");
				let contextRestored = false;
				if (archivedContextPath !== null) {
					const contextMove = yield* Effect.tryPromise({
						try: () =>
							mergeArchivedContext(archivedContextPath, restoredContextPath),
						catch: (error) =>
							error instanceof Error ? error.message : String(error),
					}).pipe(Effect.result);
					if (contextMove._tag === "Failure") {
						yield* rollbackCheckout;
						return yield* Effect.fail(failRestore(contextMove.failure));
					}
					contextRestored = true;
					const attachmentRestore = yield* sql`
            UPDATE attachments
            SET abs_path = replace(abs_path, ${archivedContextPath}, ${restoredContextPath})
            WHERE abs_path IS NOT NULL
              AND abs_path LIKE ${`${archivedContextPath}/%`}
					`.pipe(Effect.result);
					if (attachmentRestore._tag === "Failure") {
						yield* rollbackCheckout;
						return yield* Effect.fail(
							failRestore(
								`attachment path update failed: ${String(attachmentRestore.failure)}`,
							),
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
					}
					yield* rollbackCheckout;
				});

				const createdAtIso = snapshot.createdAt.toISOString();
				const inserted = yield* sql`
		  INSERT INTO worktrees
					 (id, project_id, path, name, branch, branch_provenance, base_branch, created_at,
							 setup_status, setup_output, pokemon_number)
						VALUES
							(${snapshot.id}, ${snapshot.projectId}, ${snapshot.path},
						 ${snapshot.name}, ${snapshot.branch}, ${snapshot.branchProvenance ?? "manual"}, ${snapshot.baseBranch},
							 ${createdAtIso}, 'pending', '', ${snapshot.pokemonNumber ?? null})
        `.pipe(Effect.result);
				if (inserted._tag === "Failure") {
					yield* rollbackRestore;
					return yield* Effect.fail(
						failRestore(
							`worktree row restore failed: ${String(inserted.failure)}`,
						),
					);
				}

				if (applyIsolatedCheckpoint && checkpoint !== "branch-advanced") {
					const deletedRef = yield* runGit(folder.path, [
						"update-ref",
						"-d",
						checkpointRef,
					]).pipe(Effect.result);
					if (deletedRef._tag === "Failure") {
						yield* rollbackRestore;
						return yield* Effect.fail(failRestore(deletedRef.failure));
					}
				}
				const restored = yield* get(snapshot.id);
				if (restored === null) {
					yield* rollbackRestore;
					return yield* Effect.fail(
						failRestore("restored worktree row could not be loaded"),
					);
				}

				if (contextRestored && archivedContextPath !== null) {
					yield* Effect.tryPromise(() =>
						removePath(archivedContextPath, { recursive: true }),
					).pipe(Effect.ignore);
				}
				yield* Effect.forkDetach(runSetupSafely(snapshot.id));
				return { worktree: restored, checkpoint };
			});

		const setupEnv = (
			repoPath: string,
			worktree: Worktree,
			env: Readonly<Record<string, string>>,
		): Record<string, string> => ({
			...env,
			ZUSE_RUNTIME_KIND: "local",
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

		const sharedNodeModulesLocks = new Map<string, Semaphore.Semaphore>();
		const sharedNodeModulesLock = (repoPath: string): Semaphore.Semaphore => {
			const existing = sharedNodeModulesLocks.get(repoPath);
			if (existing !== undefined) return existing;
			const created = Semaphore.makeUnsafe(1);
			sharedNodeModulesLocks.set(repoPath, created);
			return created;
		};

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

			const prepared = yield* Effect.tryPromise({
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

			const prep = prepared.output;

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
				emit(worktreeId, WorktreeSetupChunk.make({ worktreeId, output: prep }));
				emitStatus(worktreeId, "skipped", startedAtDate, finishedAtDate);
				const updated = yield* get(worktreeId);
				return updated === null
					? yield* new WorktreeSetupError({
							worktreeId,
							reason: "setup worktree row could not be loaded",
						})
					: updated;
			}

			// Persist a visible heartbeat before spawning the command. Setup tools can
			// buffer stdout for minutes (notably a fresh `bun install` on Windows), and
			// subscribers commonly attach after this detached setup has already begun.
			const startingOutput = truncateOutput(`${prep}${SETUP_STARTED_MESSAGE}`);
			yield* sql`
				UPDATE worktrees
				SET setup_output = ${startingOutput}
				WHERE id = ${worktreeId}
			`.pipe(Effect.orDie);
			emit(
				worktreeId,
				WorktreeSetupChunk.make({ worktreeId, output: startingOutput }),
			);

			const runScript = runShellScript({
				script,
				cwd: worktree.path,
				env: setupEnv(folder.path, worktree, settings.environmentVariables),
				onData: (acc) =>
					emit(
						worktreeId,
						WorktreeSetupChunk.make({
							worktreeId,
							output: truncateOutput(`${startingOutput}${acc}`),
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
			const result = prepared.sharesNodeModules
				? yield* sharedNodeModulesLock(folder.path).withPermits(1)(runScript)
				: yield* runScript;
			const finishedAtDate = yield* DateTime.nowAsDate;
			const finishedAt = finishedAtDate.toISOString();
			const status = result.exitCode === 0 ? "succeeded" : "failed";
			const output = truncateOutput(`${startingOutput}${result.output}`);
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

				yield* Effect.forkDetach(runSetupSafely(worktreeId));
				return wt;
			});

		const setupStream: WorktreeService["Service"]["setupStream"] = (
			worktreeId,
		) =>
			Stream.unwrap(
				Effect.gen(function* () {
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

					const wt = yield* get(worktreeId);
					if (wt === null) {
						return Stream.fail(new WorktreeNotFoundError({ worktreeId }));
					}

					if (Queue.sizeUnsafe(mailbox) > 0) return Stream.fromQueue(mailbox);

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
			remove,
			restore,
			rerunSetup,
			setupStream,
			startRun,
		} as const;
	}),
);
