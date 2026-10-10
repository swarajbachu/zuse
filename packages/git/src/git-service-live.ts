import { createHash } from "node:crypto";
import {
	type FolderId,
	GitBranchInfo,
	GitChange,
	type GitChangeKind,
	GitCommandError,
	GitCommit,
	GitConfirmationError,
	type GitDiffMode,
	GitDiffResult,
	GitFailingChecksArtifact,
	GitIssueSummary,
	GitNotARepoError,
	GitNotInstalledError,
	GitPrCheckRun,
	GitPrDetails,
	GitPrFile,
	GitPrInfo,
	GitPrSummary,
	GitResetRemotePreview,
	GitReviewFile,
	GitReviewFileContents,
	GitReviewPatch,
	type GitReviewScope,
	GitReviewSummary,
	GitStackResult,
	GitStalePreviewError,
	GitStatusSummary,
} from "@zuse/contracts";
import {
	type ActionsJob,
	actionsJobsApiPath,
	checkRunFromRollup,
	collectActionsRunIds,
	isFailedCheckRollup,
	metadataForRollupEntry,
} from "@zuse/git/check-runs";
import { GitService } from "@zuse/git/git-service";
import {
	DateTime,
	Duration,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Queue,
	Semaphore,
	Stream,
} from "effect";
import {
	ChildProcess as Command,
	ChildProcessSpawner as CommandExecutor,
} from "effect/unstable/process";
import { parseRemoteUrl, resolveGitHubRepository } from "./git-remote.ts";
import {
	feedbackComments,
	feedbackReviews,
	parseFeedbackPages,
	parseReviewThreads,
} from "./pr-feedback.ts";

export { parseRemoteUrl } from "./git-remote.ts";

import {
	GitHubClient,
	GitHubClientService,
	GitHubFailure,
	GitHubRequestScope,
	githubExecutionEnvironment,
} from "./github-client.ts";
import { type GitHubPr, GitHubPullRequests } from "./github-pull-requests.ts";
import { RepositoryLocator } from "./repository-locator.ts";
import {
	buildCreateReviewCommentBody,
	parseReviewIdentity,
} from "./review-comment.ts";
import {
	parseStackView,
	stackPullRequestsQuery,
	withStackPullRequests,
} from "./stack.ts";

import { makeWorkspaceChangeStreams } from "./workspace-change-streams.ts";
import {
	observeWorkspaceFingerprintPaths,
	WORKSPACE_FINGERPRINT_MAX_FILE_BYTES,
	WORKSPACE_FINGERPRINT_MAX_TOTAL_BYTES,
} from "./workspace-fingerprint.ts";

const NUL = "\0";

// `git log --format=...` separator: NUL-delimited fields, newline-delimited
// commits. Fields in this order — match `specs/0.01-MVP/features/git-history.md`.
const LOG_FORMAT = "%H%x00%h%x00%s%x00%an%x00%aI%x00%P";

const parseLogOutput = (out: string): ReadonlyArray<GitCommit> => {
	const lines = out.split("\n");
	const commits: GitCommit[] = [];
	for (const line of lines) {
		if (line.length === 0) continue;
		const [sha, shortSha, subject, authorName, authoredAt, parentsStr] =
			line.split(NUL);
		if (
			sha === undefined ||
			shortSha === undefined ||
			subject === undefined ||
			authorName === undefined ||
			authoredAt === undefined ||
			parentsStr === undefined
		) {
			continue;
		}
		commits.push(
			GitCommit.make({
				sha,
				shortSha,
				subject,
				authorName,
				authoredAt: new Date(authoredAt),
				parents: parentsStr.length === 0 ? [] : parentsStr.split(" "),
			}),
		);
	}
	return commits;
};

// `git status --porcelain=v2 --branch` header lines (per git-scm docs):
//   # branch.head <name>           (or "(detached)")
//   # branch.ab +<ahead> -<behind>
// Other lines starting with [12u?!] are file entries.
const parseStatusOutput = (out: string): GitStatusSummary => {
	let branch: string | null = null;
	let ahead = 0;
	let behind = 0;
	let dirtyFiles = 0;

	for (const line of out.split("\n")) {
		if (line.length === 0) continue;
		if (line.startsWith("# branch.head ")) {
			const name = line.slice("# branch.head ".length).trim();
			branch = name === "(detached)" ? null : name;
		} else if (line.startsWith("# branch.ab ")) {
			const rest = line.slice("# branch.ab ".length).trim();
			const parts = rest.split(/\s+/);
			for (const p of parts) {
				if (p.startsWith("+")) ahead = Number.parseInt(p.slice(1), 10) || 0;
				else if (p.startsWith("-"))
					behind = Number.parseInt(p.slice(1), 10) || 0;
			}
		} else if (line.startsWith("#")) {
			// other header line, skip
		} else {
			dirtyFiles += 1;
		}
	}

	return GitStatusSummary.make({ branch, ahead, behind, dirtyFiles });
};

const parseBranchRows = (
	localOut: string,
	remoteOut: string,
): ReadonlyArray<GitBranchInfo> => {
	const sep = "\0";
	const locals = new Set<string>();
	const result: GitBranchInfo[] = [];

	for (const line of localOut.split("\n")) {
		if (line.length === 0) continue;
		const [name, head, upstream] = line.split(sep);
		if (name === undefined || name.length === 0) continue;
		locals.add(name);
		result.push(
			GitBranchInfo.make({
				name,
				current: head === "*",
				remote: null,
				upstream: upstream && upstream.length > 0 ? upstream : null,
				kind: "local",
			}),
		);
	}

	for (const line of remoteOut.split("\n")) {
		if (line.length === 0) continue;
		const [remoteName, head] = line.split(sep);
		if (remoteName === undefined || remoteName.length === 0) continue;
		if (remoteName.endsWith("/HEAD")) continue;
		const slash = remoteName.indexOf("/");
		if (slash <= 0 || slash === remoteName.length - 1) continue;
		const branchName = remoteName.slice(slash + 1);
		if (locals.has(branchName)) continue;
		result.push(
			GitBranchInfo.make({
				name: branchName,
				current: head === "*",
				remote: remoteName,
				upstream: null,
				kind: "remote",
			}),
		);
	}

	return result;
};

// Map a single porcelain-v2 status code (per `git status --porcelain=v2`):
//   '.' unmodified, 'M' modified, 'A' added, 'D' deleted, 'R' renamed,
//   'C' copied, 'U' unmerged, 'T' type changed.
const STATUS_CODE_TO_KIND: Record<string, GitChangeKind> = {
	M: "modified",
	A: "added",
	D: "deleted",
	R: "renamed",
	C: "copied",
	U: "unmerged",
	T: "type_changed",
};

const codeToKind = (code: string): GitChangeKind | null => {
	const k = STATUS_CODE_TO_KIND[code];
	return k ?? null;
};

/**
 * Parse `git status --porcelain=v2` file entries into our wire shape.
 * Header lines (`# branch.*`) are skipped; this function focuses on the
 * file-entry lines.
 *
 * Format reference (git-scm):
 *   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
 *   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path><tab><origPath>
 *   u <XY> ...                                                    (unmerged)
 *   ? <path>                                                      (untracked)
 *   ! <path>                                                      (ignored)
 *
 * The XY pair encodes (index, working-tree) state. If working-tree is
 * unchanged we report the index state (so a staged-only file still appears
 * as modified). `staged` is true whenever index ≠ '.'.
 */
const parseChangesOutput = (out: string): ReadonlyArray<GitChange> => {
	const changes: GitChange[] = [];
	for (const line of out.split("\n")) {
		if (line.length === 0) continue;
		const tag = line[0];
		if (tag === "1") {
			// "1 XY sub mH mI mW hH hI path"
			const parts = line.split(" ");
			const xy = parts[1] ?? "..";
			const x = xy[0] ?? ".";
			const y = xy[1] ?? ".";
			const path = parts.slice(8).join(" ");
			if (path.length === 0) continue;
			const kind = codeToKind(y === "." ? x : y);
			if (kind === null) continue;
			changes.push(
				GitChange.make({ path, oldPath: null, staged: x !== ".", kind }),
			);
		} else if (tag === "2") {
			// "2 XY sub mH mI mW hH hI Xscore path<TAB>origPath"
			const tabIdx = line.indexOf("\t");
			const head = tabIdx === -1 ? line : line.slice(0, tabIdx);
			const oldPath = tabIdx === -1 ? null : line.slice(tabIdx + 1);
			const parts = head.split(" ");
			const xy = parts[1] ?? "..";
			const x = xy[0] ?? ".";
			const y = xy[1] ?? ".";
			const path = parts.slice(9).join(" ");
			if (path.length === 0) continue;
			const code = y === "." ? x : y;
			const kind: GitChangeKind = code === "C" ? "copied" : "renamed";
			changes.push(
				GitChange.make({
					path,
					oldPath,
					staged: x !== ".",
					kind: codeToKind(code) ?? kind,
				}),
			);
		} else if (tag === "u") {
			const parts = line.split(" ");
			const path = parts.slice(10).join(" ");
			if (path.length === 0) continue;
			changes.push(
				GitChange.make({
					path,
					oldPath: null,
					staged: false,
					kind: "unmerged",
				}),
			);
		} else if (tag === "?") {
			const path = line.slice(2);
			if (path.length === 0) continue;
			changes.push(
				GitChange.make({
					path,
					oldPath: null,
					staged: false,
					kind: "untracked",
				}),
			);
		} else if (tag === "!") {
			const path = line.slice(2);
			if (path.length === 0) continue;
			changes.push(
				GitChange.make({
					path,
					oldPath: null,
					staged: false,
					kind: "ignored",
				}),
			);
		}
	}
	return changes;
};

type ReviewNameEntry = {
	readonly path: string;
	readonly oldPath: string | null;
	readonly kind: GitChangeKind;
};

const reviewStatusKind = (status: string): GitChangeKind => {
	switch (status[0]) {
		case "A":
			return "added";
		case "D":
			return "deleted";
		case "R":
			return "renamed";
		case "C":
			return "copied";
		case "T":
			return "type_changed";
		case "U":
			return "unmerged";
		default:
			return "modified";
	}
};

const parseReviewNames = (out: string): ReadonlyArray<ReviewNameEntry> => {
	const fields = out.split(NUL);
	const entries: ReviewNameEntry[] = [];
	for (let index = 0; index < fields.length; ) {
		const status = fields[index++] ?? "";
		if (status.length === 0) continue;
		if (status.startsWith("R") || status.startsWith("C")) {
			const oldPath = fields[index++] ?? "";
			const currentPath = fields[index++] ?? "";
			if (currentPath.length > 0) {
				entries.push({
					path: currentPath,
					oldPath: oldPath.length > 0 ? oldPath : null,
					kind: reviewStatusKind(status),
				});
			}
			continue;
		}
		const currentPath = fields[index++] ?? "";
		if (currentPath.length > 0) {
			entries.push({
				path: currentPath,
				oldPath: null,
				kind: reviewStatusKind(status),
			});
		}
	}
	return entries;
};

type ReviewStat = {
	readonly additions: number;
	readonly deletions: number;
	readonly binary: boolean;
};

const parseReviewStats = (out: string): ReadonlyMap<string, ReviewStat> => {
	const fields = out.split(NUL);
	const stats = new Map<string, ReviewStat>();
	for (let index = 0; index < fields.length; ) {
		const header = fields[index++] ?? "";
		if (header.length === 0) continue;
		const [added = "0", deleted = "0", inlinePath = ""] = header.split("\t");
		let currentPath = inlinePath;
		if (currentPath.length === 0) {
			index += 1;
			currentPath = fields[index++] ?? "";
		}
		if (currentPath.length === 0) continue;
		const binary = added === "-" || deleted === "-";
		stats.set(currentPath, {
			additions: binary ? 0 : Number.parseInt(added, 10) || 0,
			deletions: binary ? 0 : Number.parseInt(deleted, 10) || 0,
			binary,
		});
	}
	return stats;
};

// Accepts the common shapes that `git remote get-url` emits:
//   git@github.com:owner/repo[.git]
//   ssh://git@github.com/owner/repo[.git]
//   https://github.com/owner/repo[.git]
// Returns null for anything we can't confidently parse (file:// remotes,
// custom transports, etc.) — the caller treats null as "no origin info".

/**
 * Collapse `gh`'s `statusCheckRollup` into the wire's four-state aggregate.
 *
 * A check is "in flight" if its status is anything other than COMPLETED, and
 * its conclusion (when present) tells us how a completed run landed. External
 * status checks expose `state` instead and skip `status` entirely. A single
 * failure beats every other state; otherwise pending beats success; otherwise
 * if every entry passed it's success. Empty list means no checks defined.
 */
const aggregateChecks = (
	rollup: ReadonlyArray<{
		status?: string;
		state?: string;
		conclusion?: string;
	}>,
): GitPrInfo["checks"] => {
	if (rollup.length === 0) return "none";
	let pending = false;
	for (const entry of rollup) {
		const conclusion = (entry.conclusion ?? "").toUpperCase();
		const status = (entry.status ?? "").toUpperCase();
		const state = (entry.state ?? "").toUpperCase();
		if (isFailedCheckRollup(entry)) {
			return "failure";
		}
		if (
			status === "QUEUED" ||
			status === "IN_PROGRESS" ||
			status === "PENDING" ||
			state === "PENDING" ||
			(status !== "COMPLETED" && conclusion === "" && state === "")
		) {
			pending = true;
		}
	}
	return pending ? "pending" : "success";
};

/**
 * Per-check tally over the same `statusCheckRollup` that feeds
 * {@link aggregateChecks}. Lets the top bar show "N checks running" without a
 * heavier `prDetails` fetch. Mirrors the classification rules above:
 *   failing  — conclusion/state landed on a non-success terminal state
 *   running  — queued / in-progress / pending (or a non-completed run with no
 *              conclusion or state yet)
 *   passing  — anything else (completed-success, neutral, skipped, …)
 */
const countChecks = (
	rollup: ReadonlyArray<{
		status?: string;
		state?: string;
		conclusion?: string;
	}>,
): {
	total: number;
	running: number;
	passing: number;
	failing: number;
} => {
	let running = 0;
	let passing = 0;
	let failing = 0;
	for (const entry of rollup) {
		const conclusion = (entry.conclusion ?? "").toUpperCase();
		const status = (entry.status ?? "").toUpperCase();
		const state = (entry.state ?? "").toUpperCase();
		if (isFailedCheckRollup(entry)) {
			failing += 1;
		} else if (
			status === "QUEUED" ||
			status === "IN_PROGRESS" ||
			status === "PENDING" ||
			state === "PENDING" ||
			(status !== "COMPLETED" && conclusion === "" && state === "")
		) {
			running += 1;
		} else {
			passing += 1;
		}
	}
	return { total: rollup.length, running, passing, failing };
};

export const GitServiceLive = Layer.effect(
	GitService,
	Effect.gen(function* () {
		const repositories = yield* RepositoryLocator;
		const executor = yield* CommandExecutor.ChildProcessSpawner;
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const providedGitHub = yield* GitHubClientService;
		const github = providedGitHub ?? new GitHubClient();
		const pullRequests = new GitHubPullRequests(github);
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				pullRequests.close();
				if (!providedGitHub) github.close();
			}),
		);
		const lastPr = new Map<string, { identity: string; value: GitPrInfo }>();
		const githubEffect = <T>(
			folderId: FolderId,
			read: (signal: AbortSignal) => Promise<T>,
		) =>
			Effect.tryPromise({
				try: read,
				catch: (error) =>
					new GitCommandError({
						folderId,
						reason:
							error instanceof GitHubFailure
								? `${error.kind}: ${error.message}`
								: "GitHub operation failed.",
					}),
			});
		const commandLocks = new Map<string, Semaphore.Semaphore>();
		const commandLock = (cwd: string): Semaphore.Semaphore => {
			const existing = commandLocks.get(cwd);
			if (existing !== undefined) return existing;
			const created = Semaphore.makeUnsafe(1);
			commandLocks.set(cwd, created);
			return created;
		};

		const resolvePath = repositories.root;

		/**
		 * Resolve cwd for a folder, swapping to a worktree's path when the
		 * caller passes a `worktreeId` that belongs to the project. Used by
		 * `status` so the top-bar branch + dirty/ahead counts follow the
		 * active session's worktree instead of always showing the main checkout.
		 */
		const resolvePathForWorktree = repositories.resolve;

		// Run `git ...` in `cwd`, collect stdout + stderr + exit code, and map
		// failures to our domain errors. Exit-zero returns stdout. Non-zero with
		// "not a git repository" → GitNotARepoError; spawn ENOENT → GitNotInstalled;
		// anything else → GitCommandError carrying the trimmed stderr.
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

		const runCommandUnlocked = (
			folderId: FolderId,
			cwd: string,
			args: ReadonlyArray<string>,
			acceptedExitCodes: ReadonlyArray<number> = [0],
		) =>
			Effect.scoped(
				Effect.gen(function* () {
					// Background reads must not rewrite the index and wake our own
					// checkout watcher. Required locks for mutations still apply.
					const cmd = Command.make(
						"git",
						[
							"--no-optional-locks",
							"-c",
							"diff.autoRefreshIndex=false",
							...args,
						],
						{
							cwd,
							env: yield* githubExecutionEnvironment.pipe(
								Effect.mapError(
									(error) =>
										new GitCommandError({ folderId, reason: error.message }),
								),
							),
							extendEnv: true,
						},
					);
					const proc = yield* executor.spawn(cmd);
					const stdout = yield* collectText(proc.stdout);
					const stderr = yield* collectText(proc.stderr);
					const exitCode = yield* proc.exitCode;
					if (acceptedExitCodes.includes(exitCode)) return { stdout, exitCode };
					const lower = stderr.toLowerCase();
					if (
						lower.includes("not a git repository") ||
						lower.includes("not a working tree")
					) {
						return yield* Effect.fail(new GitNotARepoError({ folderId }));
					}
					return yield* Effect.fail(
						new GitCommandError({
							folderId,
							reason: stderr.trim() || `git exited with code ${exitCode}`,
						}),
					);
				}),
			).pipe(
				Effect.catchTag("PlatformError", (error) =>
					Effect.fail(
						error.reason._tag === "NotFound"
							? new GitNotInstalledError({})
							: new GitCommandError({ folderId, reason: error.message }),
					),
				),
			);

		const runUnlocked = (
			folderId: FolderId,
			cwd: string,
			args: ReadonlyArray<string>,
		) =>
			runCommandUnlocked(folderId, cwd, args).pipe(
				Effect.map((result) => result.stdout),
			);

		const run = (
			folderId: FolderId,
			cwd: string,
			args: ReadonlyArray<string>,
		) => commandLock(cwd).withPermits(1)(runUnlocked(folderId, cwd, args));

		const hasDiff = (
			folderId: FolderId,
			cwd: string,
			args: ReadonlyArray<string>,
			paths: ReadonlyArray<string>,
		) =>
			commandLock(cwd).withPermits(1)(
				runCommandUnlocked(
					folderId,
					cwd,
					["--literal-pathspecs", "diff", "--quiet", ...args, "--", ...paths],
					[0, 1],
				).pipe(Effect.map((result) => result.exitCode === 1)),
			);

		const log: GitService["Service"]["log"] = (folderId, limit) =>
			Effect.flatMap(resolvePath(folderId), (cwd) =>
				run(folderId, cwd, [
					"log",
					`-${Math.max(1, Math.floor(limit))}`,
					`--pretty=format:${LOG_FORMAT}`,
				]).pipe(Effect.map(parseLogOutput)),
			);

		const isRepository: GitService["Service"]["isRepository"] = (folderId) =>
			Effect.flatMap(resolvePath(folderId), (cwd) =>
				run(folderId, cwd, ["rev-parse", "--is-inside-work-tree"]).pipe(
					Effect.map((output) => output.trim() === "true"),
					Effect.catchTag("GitNotARepoError", () => Effect.succeed(false)),
				),
			);

		const ignoredDirectories: GitService["Service"]["ignoredDirectories"] = (
			folderId,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				// `--ignored=matching` reports only paths that match an ignore rule.
				// `ls-files --ignored --directory` would also report an untracked
				// parent whose contents all happen to be ignored (e.g. a folder that
				// holds just `.env`), hiding files the user expects to see.
				run(folderId, cwd, [
					"status",
					"--porcelain=v1",
					"-z",
					"--ignored=matching",
					"--untracked-files=normal",
				]).pipe(
					Effect.map(
						(output): ReadonlySet<string> =>
							new Set(
								output
									.split("\0")
									.filter(
										(entry) => entry.startsWith("!! ") && entry.endsWith("/"),
									)
									.map((entry) => entry.slice(3, -1)),
							),
					),
					Effect.catchTag("GitNotARepoError", () =>
						Effect.succeed<ReadonlySet<string>>(new Set()),
					),
				),
			);

		const status: GitService["Service"]["status"] = (folderId, worktreeId) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				run(folderId, cwd, [
					"status",
					"--porcelain=v2",
					"--branch",
					"--untracked-files=all",
				]).pipe(Effect.map(parseStatusOutput)),
			);

		const branches: GitService["Service"]["branches"] = (
			folderId,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const format = "%(refname:short)%00%(HEAD)%00%(upstream:short)";
					const localOut = yield* run(folderId, cwd, [
						"branch",
						"--format",
						format,
					]);
					const remoteOut = yield* run(folderId, cwd, [
						"branch",
						"-r",
						"--format",
						format,
					]);
					return parseBranchRows(localOut, remoteOut);
				}),
			);

		const stack: GitService["Service"]["stack"] = (
			folderId,
			action,
			name,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const args = ["stack", action];
					if (action === "view") args.push("--json");
					if (action === "submit") args.push("--auto");
					if (action === "init") {
						const branch = (yield* run(folderId, cwd, [
							"symbolic-ref",
							"--short",
							"HEAD",
						])).trim();
						args.push(branch);
					}
					if (action === "add") {
						const branch = name?.trim() ?? "";
						if (!branch || branch.startsWith("-") || branch.startsWith("@"))
							return yield* Effect.fail(
								new GitCommandError({
									folderId,
									reason: "Enter a valid branch name for the next stack layer.",
								}),
							);
						yield* run(folderId, cwd, ["check-ref-format", "--branch", branch]);
						args.push(branch);
					}
					const output = yield* ghRun(
						folderId,
						cwd,
						args,
						action === "submit"
							? 300_000
							: action === "view"
								? 10_000
								: 120_000,
					);
					if (action !== "view")
						return GitStackResult.make({ output, trunk: null, branches: [] });
					const parsed = parseStackView(output);
					if (parsed === null)
						return yield* Effect.fail(
							new GitCommandError({
								folderId,
								reason:
									"GitHub CLI returned an unreadable stack. Update gh-stack and try again.",
							}),
						);
					const prUrl = parsed.branches.find((branch) => branch.pr?.url)?.pr
						?.url;
					const repository = prUrl
						? parseRemoteUrl(prUrl.replace(/\/pull\/\d+.*$/, ""))
						: null;
					const query = repository
						? stackPullRequestsQuery(parsed, repository.owner, repository.repo)
						: null;
					if (!repository || !query) return parsed;
					const credentialScope = (yield* GitHubRequestScope) ?? undefined;
					const metadata = yield* githubEffect(folderId, async (signal) => {
						const credential = await github.credential(
							{ ...repository, cwd, credentialScope },
							signal,
						);
						return JSON.stringify({
							data: await github.graphql(credential, query, {}, signal),
						});
					}).pipe(Effect.catch(() => Effect.succeed("")));
					return withStackPullRequests(parsed, metadata);
				}),
			);

		const switchBranch: GitService["Service"]["switchBranch"] = (
			folderId,
			branch,
			remote,
			worktreeId,
			createFrom,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const target = branch.trim();
					if (target.length === 0) {
						return yield* Effect.fail(
							new GitCommandError({
								folderId,
								reason: "Branch name cannot be empty.",
							}),
						);
					}
					const remoteTarget = remote?.trim() ?? "";
					if (createFrom !== undefined) {
						yield* run(folderId, cwd, ["check-ref-format", "--branch", target]);
						if (target.startsWith("-") || target.startsWith("@"))
							return yield* Effect.fail(
								new GitCommandError({
									folderId,
									reason: "Enter a literal branch name.",
								}),
							);
						if (createFrom === "origin/main") {
							const ensureClean = Effect.gen(function* () {
								const dirty = yield* run(folderId, cwd, [
									"status",
									"--porcelain",
								]);
								if (dirty.trim())
									return yield* Effect.fail(
										new GitCommandError({
											folderId,
											reason:
												"Commit or stash changes before starting from origin/main.",
										}),
									);
							});
							yield* ensureClean;
							yield* run(folderId, cwd, [
								"fetch",
								"origin",
								"refs/heads/main:refs/remotes/origin/main",
							]);
							yield* ensureClean;
						}
						yield* run(folderId, cwd, [
							"switch",
							"--no-track",
							"-c",
							target,
							createFrom,
						]);
					} else if (remoteTarget.length > 0) {
						yield* run(folderId, cwd, ["switch", "--track", remoteTarget]);
					} else {
						yield* run(folderId, cwd, ["switch", target]);
					}
					const out = yield* run(folderId, cwd, [
						"status",
						"--porcelain=v2",
						"--branch",
					]);
					return parseStatusOutput(out);
				}),
			);

		const renameBranch: GitService["Service"]["renameBranch"] = (
			folderId,
			name,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const next = name.trim();
					if (next.length === 0) {
						return yield* Effect.fail(
							new GitCommandError({
								folderId,
								reason: "Branch name cannot be empty.",
							}),
						);
					}
					const current = (yield* run(folderId, cwd, [
						"branch",
						"--show-current",
					])).trim();
					if (current.length === 0) {
						return yield* Effect.fail(
							new GitCommandError({
								folderId,
								reason: "Cannot rename a detached HEAD.",
							}),
						);
					}
					yield* run(folderId, cwd, ["check-ref-format", "--branch", next]);
					if (current !== next) {
						yield* run(folderId, cwd, ["branch", "-m", current, next]);
					}
					const out = yield* run(folderId, cwd, [
						"status",
						"--porcelain=v2",
						"--branch",
					]);
					return parseStatusOutput(out);
				}),
			);

		// `git config user.name` exits non-zero (code 1) when the key is unset.
		// We don't want that to read as a hard failure — an empty author name is
		// a legitimate state — so a GitCommandError collapses to "".
		const getUserName: GitService["Service"]["getUserName"] = (folderId) =>
			Effect.flatMap(resolvePath(folderId), (cwd) =>
				run(folderId, cwd, ["config", "user.name"]).pipe(
					Effect.map((s) => s.trim()),
					Effect.catchTag("GitCommandError", () => Effect.succeed("")),
				),
			);

		// `git remote get-url origin` exits non-zero when no remote is set; we
		// treat the resulting GitCommandError as "no origin" → null.
		const origin: GitService["Service"]["origin"] = (folderId) =>
			Effect.flatMap(resolvePath(folderId), (cwd) =>
				run(folderId, cwd, ["remote", "get-url", "origin"]).pipe(
					Effect.map((s) => parseRemoteUrl(s.trim())),
					Effect.catchTag("GitCommandError", () => Effect.succeed(null)),
				),
			);

		// gh-stack owns local stack mutations; all API enrichment uses the shared client.
		const ghRun = (
			folderId: FolderId,
			cwd: string,
			args: ReadonlyArray<string>,
			timeoutMs = 10_000,
		) =>
			Effect.scoped(
				Effect.gen(function* () {
					const cmd = Command.make("gh", args, {
						cwd,
						env: yield* githubExecutionEnvironment.pipe(
							Effect.mapError(
								(error) =>
									new GitCommandError({ folderId, reason: error.message }),
							),
						),
						extendEnv: true,
					});
					const proc = yield* executor.spawn(cmd);
					const [stdout, stderr, exitCode] = yield* Effect.all(
						[collectText(proc.stdout), collectText(proc.stderr), proc.exitCode],
						{ concurrency: "unbounded" },
					);
					if (exitCode === 0) return stdout;
					return yield* Effect.fail(
						new GitCommandError({
							folderId,
							reason: stderr.trim() || `gh exited with code ${exitCode}`,
						}),
					);
				}),
			).pipe(
				Effect.timeout(timeoutMs),
				Effect.catchTag("TimeoutError", () =>
					Effect.fail(
						new GitCommandError({
							folderId,
							reason: `GitHub CLI timed out after ${timeoutMs / 1000} seconds`,
						}),
					),
				),
				Effect.catchTag("PlatformError", (error) =>
					Effect.fail(
						error.reason._tag === "NotFound"
							? new GitNotInstalledError({})
							: new GitCommandError({ folderId, reason: error.message }),
					),
				),
			);

		const githubRepository = (folderId: FolderId, cwd: string) =>
			resolveGitHubRepository(cwd, (args) => run(folderId, cwd, args));
		const githubHead = (folderId: FolderId, cwd: string, branch: string) =>
			Effect.gen(function* () {
				const remote = (yield* run(folderId, cwd, [
					"config",
					"--get",
					`branch.${branch}.remote`,
				]).pipe(Effect.catch(() => Effect.succeed("origin")))).trim();
				const merge = (yield* run(folderId, cwd, [
					"config",
					"--get",
					`branch.${branch}.merge`,
				]).pipe(Effect.catch(() => Effect.succeed(""))))
					.trim()
					.replace(/^refs\/heads\//, "");
				const url = yield* run(folderId, cwd, [
					"remote",
					"get-url",
					remote,
				]).pipe(Effect.catch(() => Effect.succeed("")));
				return {
					branch: merge && branch.endsWith(`/${merge}`) ? merge : branch,
					owner: parseRemoteUrl(url.trim())?.owner,
				};
			});
		const currentPr = (
			folderId: FolderId,
			cwd: string,
			options: { interactive?: boolean; force?: boolean } = {},
		) =>
			Effect.gen(function* () {
				const repository = yield* githubRepository(folderId, cwd);
				const branch = (yield* run(folderId, cwd, [
					"rev-parse",
					"--abbrev-ref",
					"HEAD",
				])).trim();
				if (!repository || branch === "HEAD") return null;
				const head = yield* githubHead(folderId, cwd, branch);
				const number = yield* githubEffect(folderId, (signal) =>
					pullRequests.discover(
						repository,
						head.branch,
						signal,
						options.interactive,
						options.force,
						head.owner,
					),
				);
				if (number === null) return null;
				const pr = yield* githubEffect(folderId, (signal) =>
					pullRequests.read(repository, number, signal, options),
				);
				return { repository, pr, branch };
			});
		const emptyPr = (
			branch: string | null,
			capability: GitPrInfo["prCapability"] = "available",
		): GitPrInfo =>
			GitPrInfo.make({
				nodeId: null,
				state: "none",
				branch,
				baseBranch: null,
				additions: 0,
				deletions: 0,
				number: null,
				url: null,
				isDraft: false,
				checks: "none",
				mergeable: "unknown",
				checksTotal: 0,
				checksRunning: 0,
				checksPassing: 0,
				checksFailing: 0,
				autoMergeEnabled: false,
				prCapability: capability,
				stale: capability !== "available",
				checksComplete: false,
			});
		const infoFromPr = (pr: GitHubPr): GitPrInfo => {
			const counts = countChecks(pr.statusCheckRollup);
			return GitPrInfo.make({
				nodeId: pr.id,
				state:
					pr.state === "OPEN"
						? "open"
						: pr.state === "MERGED"
							? "merged"
							: "closed",
				branch: pr.headRefName,
				baseBranch: pr.baseRefName,
				headSha: pr.headRefOid,
				additions: pr.additions,
				deletions: pr.deletions,
				number: pr.number,
				url: pr.url,
				isDraft: pr.isDraft,
				checks: aggregateChecks(pr.statusCheckRollup),
				checkRuns: pr.statusCheckRollup.map(checkRunFromRollup),
				mergeable: mapMergeable(pr.mergeable),
				checksTotal: counts.total,
				checksRunning: counts.running,
				checksPassing: counts.passing,
				checksFailing: counts.failing,
				autoMergeEnabled: pr.autoMergeRequest != null,
				prCapability: "available",
				stale: false,
				statusRevision: pr.statusRevision,
				remarksRevision: pr.remarksRevision,
				observedAt: new Date(pr.observedAt),
				checksComplete: pr.checksComplete,
			});
		};
		const prState: GitService["Service"]["prState"] = (
			folderId,
			worktreeId,
			options = {},
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const branch = (yield* run(folderId, cwd, [
						"rev-parse",
						"--abbrev-ref",
						"HEAD",
					])).trim();
					const repository = yield* githubRepository(folderId, cwd);
					if (!repository || branch === "HEAD") {
						lastPr.delete(`${cwd}\0${(yield* GitHubRequestScope)?.key ?? ""}`);
						return emptyPr(branch === "HEAD" ? null : branch);
					}
					const cacheKey = `${cwd}\0${repository.credentialScope?.key ?? ""}`;
					const head = yield* githubHead(folderId, cwd, branch);
					return yield* Effect.tryPromise({
						try: async (signal) => {
							let identity: string | undefined;
							try {
								const credential = await github.credential(repository, signal);
								identity = JSON.stringify([
									credential.fingerprint,
									repository.host,
									repository.owner,
									repository.repo,
									branch,
								]);
								if (lastPr.get(cacheKey)?.identity !== identity)
									lastPr.delete(cacheKey);
								const number = await pullRequests.discover(
									repository,
									head.branch,
									signal,
									options.interactive,
									options.force,
									head.owner,
								);
								const value =
									number === null
										? emptyPr(branch)
										: infoFromPr(
												await pullRequests.read(
													repository,
													number,
													signal,
													options,
												),
											);
								if (lastPr.size >= 512)
									lastPr.delete(lastPr.keys().next().value ?? "");
								const snapshot = GitPrInfo.make({ ...value, branch });
								lastPr.set(cacheKey, { identity, value: snapshot });
								return snapshot;
							} catch (error) {
								if (signal.aborted) throw error;
								const failure =
									error instanceof GitHubFailure
										? error
										: new GitHubFailure("unknown", "GitHub refresh failed.");
								const previous = lastPr.get(cacheKey);
								const value =
									previous &&
									previous.identity === identity &&
									failure.kind !== "authentication"
										? previous.value
										: emptyPr(branch);
								return GitPrInfo.make({
									...value,
									prCapability: failure.kind,
									stale: true,
									retryAt: failure.retryAt ? new Date(failure.retryAt) : null,
								});
							}
						},
						catch: () =>
							new GitCommandError({
								folderId,
								reason: "GitHub refresh was interrupted.",
							}),
					});
				}),
			);

		const mapMergeable = (raw: string | undefined): GitPrInfo["mergeable"] => {
			switch ((raw ?? "").toUpperCase()) {
				case "MERGEABLE":
				case "CLEAN":
					return "clean";
				case "CONFLICTING":
					return "conflicting";
				default:
					return "unknown";
			}
		};

		const emptyDetails: GitPrDetails = GitPrDetails.make({
			state: "none",
			number: null,
			url: null,
			isDraft: false,
			checks: "none",
			mergeable: "unknown",
			additions: 0,
			deletions: 0,
			title: "",
			body: "",
			author: "",
			baseBranch: null,
			headBranch: null,
			comments: [],
			reviews: [],
			files: [],
			checkRuns: [],
		});

		const createReviewComment: GitService["Service"]["createReviewComment"] = (
			folderId,
			filePath,
			line,
			side,
			body,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const current = yield* currentPr(folderId, cwd, { force: true });
					if (!current)
						return yield* Effect.fail(
							new GitCommandError({
								folderId,
								reason: "No pull request is available for this branch.",
							}),
						);
					const result = yield* githubEffect(folderId, async (signal) => {
						const credential = await github.credential(
							current.repository,
							signal,
						);
						return github.rest<{ html_url?: string }>(
							credential,
							`repos/${current.repository.owner}/${current.repository.repo}/pulls/${current.pr.number}/comments`,
							signal,
							{
								method: "POST",
								body: buildCreateReviewCommentBody({
									body,
									headSha: current.pr.headRefOid,
									path: filePath,
									line,
									side,
								}),
								interactive: true,
							},
						);
					});
					pullRequests.invalidate();
					return { url: result.html_url ?? null };
				}),
			);

		const reviewIdentity: GitService["Service"]["reviewIdentity"] = (
			folderId,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const repository = yield* githubRepository(folderId, cwd);
					if (!repository) return null;
					return yield* githubEffect(folderId, async (signal) => {
						const credential = await github.credential(repository, signal);
						return parseReviewIdentity(
							JSON.stringify(await github.rest(credential, "user", signal)),
						);
					}).pipe(Effect.catch(() => Effect.succeed(null)));
				}),
			);

		const prDetails: GitService["Service"]["prDetails"] = (
			folderId,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const current = yield* currentPr(folderId, cwd);
					if (!current) return emptyDetails;
					const { repository, pr } = current;
					return yield* githubEffect(folderId, async (signal) => {
						const credential = await github.credential(repository, signal);
						const [feedback, files, jobs] = await Promise.all([
							pullRequests.feedback(repository, pr, signal),
							pullRequests.files(repository, pr, signal),
							Promise.all(
								collectActionsRunIds(pr.statusCheckRollup).map(
									async (runId) => {
										try {
											return [
												runId,
												await github.pages<ActionsJob>(
													credential,
													actionsJobsApiPath(
														repository.owner,
														repository.repo,
														runId,
													),
													signal,
													(value) => (value as { jobs: ActionsJob[] }).jobs,
												),
											] as const;
										} catch (error) {
											if (
												error instanceof GitHubFailure &&
												error.kind === "access"
											)
												return [runId, []] as const;
											throw error;
										}
									},
								),
							),
						]);
						const threads = parseReviewThreads(
							JSON.stringify(feedback.threads),
						);
						const discussion =
							parseFeedbackPages(JSON.stringify([feedback.comments])) ?? [];
						const inline =
							parseFeedbackPages(JSON.stringify([feedback.inline])) ?? [];
						const reviews =
							parseFeedbackPages(JSON.stringify([feedback.reviews])) ?? [];
						const jobsByRunId = new Map<string, ReadonlyArray<ActionsJob>>(
							jobs,
						);
						return GitPrDetails.make({
							...infoFromPr(pr),
							title: pr.title,
							body: pr.body,
							author: pr.author?.login ?? "",
							authorAvatarUrl: pr.author?.avatarUrl ?? null,
							headBranch: current.branch,
							headSha: pr.headRefOid,
							baseBranch: pr.baseRefName,
							comments: [
								...feedbackComments(discussion),
								...feedbackComments(inline, threads),
							],
							reviews: feedbackReviews(reviews, threads, inline),
							files: files.map((file) => GitPrFile.make(file)),
							checkRuns: pr.statusCheckRollup.map((check) =>
								GitPrCheckRun.make({
									...checkRunFromRollup(check),
									...metadataForRollupEntry(check, jobsByRunId),
									appName: check.checkSuite?.app?.name ?? null,
									appAvatarUrl: check.checkSuite?.app?.logoUrl ?? null,
								}),
							),
						});
					});
				}),
			);

		const githubJsonList = <T>(folderId: FolderId, type: "pr" | "issue") =>
			Effect.flatMap(resolvePathForWorktree(folderId, null), (cwd) =>
				Effect.gen(function* () {
					const repository = yield* githubRepository(folderId, cwd);
					if (!repository) return [] as T[];
					return yield* githubEffect(
						folderId,
						async (signal) =>
							(await pullRequests.list(repository, type, signal)) as T[],
					);
				}),
			);

		const listPrs: GitService["Service"]["listPrs"] = (folderId) =>
			githubJsonList<{
				number?: number;
				title?: string;
				author?: { login?: string };
				headRefName?: string;
				isCrossRepository?: boolean;
				isDraft?: boolean;
				state?: string;
				updatedAt?: string;
			}>(folderId, "pr").pipe(
				Effect.map((rows) =>
					rows
						.filter((r) => typeof r.number === "number")
						.map((r) =>
							GitPrSummary.make({
								number: r.number as number,
								title: r.title ?? "",
								author: r.author?.login ?? "",
								headRefName: r.headRefName ?? "",
								isCrossRepository: r.isCrossRepository === true,
								isDraft: r.isDraft === true,
								state: (r.state ?? "OPEN").toLowerCase(),
								updatedAt: new Date(r.updatedAt ?? 0),
							}),
						),
				),
			);

		const listIssues: GitService["Service"]["listIssues"] = (folderId) =>
			githubJsonList<{
				number?: number;
				title?: string;
				author?: { login?: string };
				state?: string;
				labels?: ReadonlyArray<{ name?: string }>;
				updatedAt?: string;
			}>(folderId, "issue").pipe(
				Effect.map((rows) =>
					rows
						.filter((r) => typeof r.number === "number")
						.map((r) =>
							GitIssueSummary.make({
								number: r.number as number,
								title: r.title ?? "",
								author: r.author?.login ?? "",
								state: (r.state ?? "OPEN").toLowerCase(),
								labels: (r.labels ?? [])
									.map((l) => l.name ?? "")
									.filter((n) => n.length > 0),
								updatedAt: new Date(r.updatedAt ?? 0),
							}),
						),
				),
			);

		const issueMarkdown: GitService["Service"]["issueMarkdown"] = (
			folderId,
			number,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, null), (cwd) =>
				Effect.gen(function* () {
					const repository = yield* githubRepository(folderId, cwd);
					if (!repository) return { number, title: "", url: "", markdown: "" };
					const stdout = yield* githubEffect(folderId, async (signal) => {
						const credential = await github.credential(repository, signal);
						const root = `repos/${repository.owner}/${repository.repo}/issues/${number}`;
						const [issue, comments] = await Promise.all([
							github.rest<{
								title: string;
								body: string;
								html_url: string;
								user: { login: string };
								labels: unknown[];
							}>(credential, root, signal),
							github.pages<{
								body: string;
								user: { login: string };
								created_at: string;
							}>(credential, `${root}/comments`, signal),
						]);
						return JSON.stringify({
							...issue,
							url: issue.html_url,
							author: issue.user,
							comments: comments.map((comment) => ({
								body: comment.body,
								author: comment.user,
								createdAt: comment.created_at,
							})),
						});
					});
					const empty = { number, title: "", url: "", markdown: "" };
					if (stdout.trim().length === 0) return empty;

					let parsed: {
						number?: number;
						title?: string;
						body?: string;
						url?: string;
						author?: { login?: string };
						labels?: ReadonlyArray<{ name?: string }>;
						comments?: ReadonlyArray<{
							author?: { login?: string };
							body?: string;
							createdAt?: string;
						}>;
					};
					try {
						parsed = JSON.parse(stdout) as typeof parsed;
					} catch {
						return empty;
					}

					const title = parsed.title ?? "";
					const url = parsed.url ?? "";
					const labels = (parsed.labels ?? [])
						.map((l) => l.name ?? "")
						.filter((n) => n.length > 0);
					const lines: string[] = [`# ${title} (#${number})`, ""];
					const meta: string[] = [];
					if (parsed.author?.login)
						meta.push(`**Author:** @${parsed.author.login}`);
					if (url.length > 0) meta.push(`**URL:** ${url}`);
					if (labels.length > 0) meta.push(`**Labels:** ${labels.join(", ")}`);
					if (meta.length > 0) lines.push(meta.join(" · "), "");
					const body = (parsed.body ?? "").trim();
					lines.push(body.length > 0 ? body : "_(no description)_", "");
					for (const c of parsed.comments ?? []) {
						const author = c.author?.login ?? "someone";
						lines.push(
							`## Comment by @${author}`,
							"",
							(c.body ?? "").trim(),
							"",
						);
					}
					const markdown = `${lines
						.join("\n")
						.replace(/\n{3,}/g, "\n\n")
						.trimEnd()}\n`;
					return { number, title, url, markdown };
				}),
			);

		const detectBaseRef = (folderId: FolderId, cwd: string) =>
			run(folderId, cwd, [
				"symbolic-ref",
				"--quiet",
				"refs/remotes/origin/HEAD",
			]).pipe(
				Effect.map((s) => s.trim().replace(/^refs\/remotes\//, "")),
				Effect.catch(() =>
					Effect.gen(function* () {
						for (const ref of [
							"origin/main",
							"origin/master",
							"main",
							"master",
						]) {
							const found = yield* run(folderId, cwd, [
								"rev-parse",
								"--verify",
								"--quiet",
								ref,
							]).pipe(
								Effect.as(ref as string | null),
								Effect.catch(() => Effect.succeed(null)),
							);
							if (found !== null) return found;
						}
						return null;
					}),
				),
			);

		const resolveReviewRange = (folderId: FolderId, cwd: string) =>
			Effect.gen(function* () {
				const headSha = yield* run(folderId, cwd, ["rev-parse", "HEAD"]).pipe(
					Effect.map((value) => value.trim()),
					Effect.catch(() => Effect.succeed("")),
				);
				const baseRef = yield* detectBaseRef(folderId, cwd);
				const baseSha =
					baseRef === null || headSha.length === 0
						? headSha
						: yield* run(folderId, cwd, ["merge-base", baseRef, "HEAD"]).pipe(
								Effect.map((value) => value.trim()),
								Effect.catch(() => Effect.succeed(headSha)),
							);
				return { baseRef, baseSha, headSha } as const;
			});

		const resolveReviewComparison = (
			folderId: FolderId,
			cwd: string,
			scope: GitReviewScope,
		) =>
			Effect.gen(function* () {
				const range = yield* resolveReviewRange(folderId, cwd);
				const headRef = yield* run(folderId, cwd, [
					"symbolic-ref",
					"--quiet",
					"--short",
					"HEAD",
				]).pipe(
					Effect.map((value) => value.trim()),
					Effect.catch(() => Effect.succeed(null)),
				);
				if (scope === "branch") {
					return {
						...range,
						headRef,
						args: range.baseSha.length === 0 ? [] : [range.baseSha],
					} as const;
				}
				return {
					baseRef: scope === "staged" ? "HEAD" : null,
					headRef,
					baseSha: range.headSha,
					headSha: range.headSha,
					args: scope === "staged" ? ["--cached", "HEAD"] : [],
				} as const;
			});

		const changes: GitService["Service"]["changes"] = (folderId, worktreeId) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				run(folderId, cwd, [
					"status",
					"--porcelain=v2",
					"--untracked-files=all",
				]).pipe(Effect.map(parseChangesOutput)),
			);

		/**
		 * Branch-review diff for a single path. The renderer feeds the
		 * returned `patch` directly into `@pierre/diffs` `PatchDiff`. Modes:
		 *   - worktree : tracked + modified (or modified + deleted)
		 *   - deleted  : tracked but missing on disk
		 *   - untracked: not in HEAD — synthesize a /dev/null→file diff so new
		 *                files render the same as edits
		 *   - binary   : git classifies the file as binary (no patch returned)
		 *   - unchanged: clean vs the resolved review base (empty patch)
		 * Patches over 2 MiB are sliced so the renderer never has to handle a
		 * tens-of-megabytes diff string.
		 */
		const diff: GitService["Service"]["diff"] = (folderId, p, worktreeId) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const rel = path.isAbsolute(p) ? path.relative(cwd, p) : p;
					const { baseSha } = yield* resolveReviewRange(folderId, cwd);
					const MAX_BYTES = 2_000_000;

					const finish = (mode: GitDiffMode, patch: string): GitDiffResult => {
						const bytes = patch.length;
						const truncated = bytes > MAX_BYTES;
						return new GitDiffResult({
							mode,
							patch: truncated ? patch.slice(0, MAX_BYTES) : patch,
							truncated,
							bytes,
						});
					};

					// Tracked vs untracked. `ls-files --error-unmatch` exits 1 when the
					// path isn't in the index — we catch that as "untracked".
					const trackedInIndex = yield* run(folderId, cwd, [
						"ls-files",
						"--error-unmatch",
						"--",
						rel,
					]).pipe(
						Effect.map(() => true),
						Effect.catchTag("GitCommandError", () => Effect.succeed(false)),
					);
					const trackedAtBase =
						baseSha.length === 0
							? false
							: yield* run(folderId, cwd, [
									"cat-file",
									"-e",
									`${baseSha}:${rel}`,
								]).pipe(
									Effect.as(true),
									Effect.catch(() => Effect.succeed(false)),
								);
					const tracked = trackedInIndex || trackedAtBase;

					if (!tracked) {
						// Untracked: build a synthetic /dev/null → file diff so the
						// renderer treats new files identically to modifications. Inspect
						// metadata before reading: synthesizing a patch is bounded by the same
						// 2 MiB payload limit, so reading a larger file can only waste memory and
						// block the Git lane. Oversized and non-regular paths use the existing
						// no-textual-diff mode shared with binary files.
						const absolutePath = path.resolve(cwd, rel);
						const info = yield* fs
							.stat(absolutePath)
							.pipe(Effect.catch(() => Effect.succeed(null)));
						if (info === null) {
							return finish("unchanged", "");
						}
						if (info.type !== "File" || info.size > BigInt(MAX_BYTES)) {
							return new GitDiffResult({
								mode: "binary",
								patch: "",
								truncated: info.size > BigInt(MAX_BYTES),
								bytes: Number(
									info.size > BigInt(Number.MAX_SAFE_INTEGER)
										? BigInt(Number.MAX_SAFE_INTEGER)
										: info.size,
								),
							});
						}
						const content = yield* fs.readFileString(absolutePath).pipe(
							Effect.catch((err) =>
								Effect.fail(
									new GitCommandError({
										folderId,
										reason: `read ${rel}: ${String(err)}`,
									}),
								),
							),
						);
						if (content.includes(NUL)) {
							return finish("binary", "");
						}
						if (content.length === 0) {
							const header =
								`diff --git a/${rel} b/${rel}\n` +
								`new file mode 100644\n` +
								`--- /dev/null\n` +
								`+++ b/${rel}\n`;
							return finish("untracked", header);
						}
						const lines = content.split("\n");
						// A trailing newline yields a final empty element — that line
						// doesn't get a `+` marker; git emits "\ No newline at end of
						// file" if it's missing, and nothing if present.
						const hasTrailingNewline = content.endsWith("\n");
						const bodyLines = hasTrailingNewline ? lines.slice(0, -1) : lines;
						const newCount = bodyLines.length;
						const body = bodyLines.map((l) => `+${l}`).join("\n");
						const noNewline = hasTrailingNewline
							? ""
							: "\n\\ No newline at end of file";
						const patch =
							`diff --git a/${rel} b/${rel}\n` +
							`new file mode 100644\n` +
							`--- /dev/null\n` +
							`+++ b/${rel}\n` +
							`@@ -0,0 +1,${newCount} @@\n` +
							body +
							noNewline +
							"\n";
						return finish("untracked", patch);
					}

					// Tracked. Use numstat to detect binary + unchanged cheaply.
					if (baseSha.length === 0) return finish("unchanged", "");
					const numstat = (yield* run(folderId, cwd, [
						"diff",
						"--numstat",
						baseSha,
						"--",
						rel,
					])).trim();

					if (numstat.length === 0) {
						return finish("unchanged", "");
					}
					// Format: "<added>\t<deleted>\t<path>". Binary files report "-\t-".
					const firstTab = numstat.indexOf("\t");
					if (firstTab > 0 && numstat.startsWith("-\t-")) {
						return finish("binary", "");
					}

					const patch = yield* run(folderId, cwd, [
						"diff",
						"--no-color",
						"--no-ext-diff",
						baseSha,
						"--",
						rel,
					]);

					// Deleted: tracked file missing from working tree. The patch still
					// reads correctly; we just label the mode so the renderer can show
					// "(deleted)" context.
					const stillExists = yield* fs
						.exists(path.resolve(cwd, rel))
						.pipe(Effect.catch(() => Effect.succeed(false)));
					const mode: GitDiffMode = stillExists ? "worktree" : "deleted";
					return finish(mode, patch);
				}),
			);

		const readReviewSummary = (
			folderId: Parameters<GitService["Service"]["reviewSummary"]>[0],
			worktreeId: Parameters<GitService["Service"]["reviewSummary"]>[1],
			scope: GitReviewScope,
			preloadedChanges?: ReadonlyArray<GitChange>,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const comparison = yield* resolveReviewComparison(
						folderId,
						cwd,
						scope,
					);
					const uncommitted =
						preloadedChanges ?? (yield* changes(folderId, worktreeId));
					const names = parseReviewNames(
						yield* run(folderId, cwd, [
							"diff",
							"--name-status",
							"-z",
							"--find-renames",
							...comparison.args,
							"--",
						]),
					);
					const stats = parseReviewStats(
						yield* run(folderId, cwd, [
							"diff",
							"--numstat",
							"-z",
							"--find-renames",
							...comparison.args,
							"--",
						]),
					);
					const pendingByPath = new Map<string, GitChange>();
					for (const change of uncommitted) {
						pendingByPath.set(change.path, change);
						if (change.oldPath !== null)
							pendingByPath.set(change.oldPath, change);
					}
					// Binary numstat entries can also be caused by stale file stats.
					// Status validates pending changes; a tree-to-tree diff validates
					// committed changes without trusting working-tree timestamps.
					const binaryNames = names.filter(
						(entry) =>
							stats.get(entry.path)?.binary && entry.kind !== "unmerged",
					);
					const committedBinaryPaths = new Set<string>();
					if (
						scope === "branch" &&
						comparison.baseSha !== comparison.headSha &&
						binaryNames.some((entry) => !pendingByPath.has(entry.path))
					) {
						const committedNames = parseReviewNames(
							yield* run(folderId, cwd, [
								"diff",
								"--name-status",
								"-z",
								"--find-renames",
								comparison.baseSha,
								comparison.headSha,
								"--",
							]),
						);
						for (const entry of committedNames)
							committedBinaryPaths.add(entry.path);
					}
					const changedBinaryPaths = new Set(
						binaryNames
							.filter(
								(entry) =>
									scope === "staged" ||
									(scope === "branch" &&
										(pendingByPath.has(entry.path) ||
											committedBinaryPaths.has(entry.path))),
							)
							.map((entry) => entry.path),
					);
					// Unstaged scope needs to distinguish staged-only files. Quiet
					// diffs verify those candidates without materializing patches.
					const unstagedBinaryNames =
						scope === "unstaged"
							? binaryNames.filter((entry) => pendingByPath.has(entry.path))
							: [];
					const binaryGroups: ReviewNameEntry[][] = [];
					for (
						let index = 0;
						index < unstagedBinaryNames.length;
						index += 128
					) {
						binaryGroups.push(unstagedBinaryNames.slice(index, index + 128));
					}
					while (binaryGroups.length > 0) {
						const group = binaryGroups.pop();
						if (group === undefined) break;
						const changed = yield* hasDiff(
							folderId,
							cwd,
							comparison.args,
							group.map((entry) => entry.path),
						);
						if (!changed) continue;
						if (group.length === 1) {
							for (const entry of group) changedBinaryPaths.add(entry.path);
						} else {
							const middle = Math.floor(group.length / 2);
							binaryGroups.push(group.slice(0, middle), group.slice(middle));
						}
					}

					// With index refresh disabled, --name-status can report stale
					// file stats as modifications even when the contents match.
					// Keep real zero-line changes, including modes and renames.
					const files: GitReviewFile[] = names
						.filter(
							(entry) =>
								entry.kind === "unmerged" ||
								(stats.get(entry.path)?.binary
									? changedBinaryPaths.has(entry.path)
									: stats.has(entry.path)),
						)
						.map((entry) => {
							const stat = stats.get(entry.path) ?? {
								additions: 0,
								deletions: 0,
								binary: false,
							};
							const pending =
								pendingByPath.get(entry.path) ??
								(entry.oldPath === null
									? undefined
									: pendingByPath.get(entry.oldPath));
							return GitReviewFile.make({
								...entry,
								...stat,
								conflict:
									entry.kind === "unmerged" || pending?.kind === "unmerged",
								hasUncommittedChanges:
									scope === "branch" ? pending !== undefined : true,
							});
						});
					const seen = new Set(
						files.flatMap((file) => [file.path, file.oldPath ?? ""]),
					);
					let untrackedContentBytes = 0n;
					for (const pending of uncommitted) {
						if (
							pending.kind === "ignored" ||
							seen.has(pending.path) ||
							scope === "staged" ||
							(scope === "unstaged" && pending.kind !== "untracked")
						)
							continue;
						let stat: ReviewStat = {
							additions: 0,
							deletions: 0,
							binary: false,
						};
						if (pending.kind === "untracked") {
							const absolutePath = path.resolve(cwd, pending.path);
							const fileInfo = yield* fs.stat(absolutePath).pipe(
								Effect.map((info) => ({ _tag: "Available" as const, info })),
								Effect.catch(() =>
									Effect.succeed({ _tag: "Unavailable" as const }),
								),
							);
							const canRead =
								fileInfo._tag === "Available" &&
								fileInfo.info.type === "File" &&
								fileInfo.info.size <= WORKSPACE_FINGERPRINT_MAX_FILE_BYTES &&
								untrackedContentBytes + fileInfo.info.size <=
									WORKSPACE_FINGERPRINT_MAX_TOTAL_BYTES;
							if (!canRead) {
								stat = { additions: 0, deletions: 0, binary: true };
							} else {
								untrackedContentBytes += fileInfo.info.size;
								const contents = yield* fs.readFileString(absolutePath).pipe(
									Effect.map((value) => ({
										_tag: "Available" as const,
										value,
									})),
									Effect.catch(() =>
										Effect.succeed({ _tag: "Unavailable" as const }),
									),
								);
								stat =
									contents._tag === "Unavailable"
										? { additions: 0, deletions: 0, binary: true }
										: {
												additions:
													contents.value.length === 0
														? 0
														: contents.value.split("\n").length,
												deletions: 0,
												binary: contents.value.includes(NUL),
											};
							}
						}
						files.push(
							GitReviewFile.make({
								path: pending.path,
								oldPath: pending.oldPath,
								kind: pending.kind,
								...stat,
								conflict: pending.kind === "unmerged",
								hasUncommittedChanges: true,
							}),
						);
					}
					files.sort((left, right) => left.path.localeCompare(right.path));
					return GitReviewSummary.make({
						baseRef: comparison.baseRef,
						headRef: comparison.headRef,
						scope,
						baseSha: comparison.baseSha,
						headSha: comparison.headSha,
						files,
						additions: files.reduce((total, file) => total + file.additions, 0),
						deletions: files.reduce((total, file) => total + file.deletions, 0),
					});
				}),
			);

		const reviewSummary: GitService["Service"]["reviewSummary"] = (
			folderId,
			worktreeId,
			scope = "branch",
		) => readReviewSummary(folderId, worktreeId, scope);

		const workspaceSnapshot: GitService["Service"]["workspaceSnapshot"] = (
			folderId,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const porcelain = yield* run(folderId, cwd, [
						"status",
						"--porcelain=v2",
						"--branch",
						"--untracked-files=all",
					]);
					const observedChanges = parseChangesOutput(porcelain);
					const observedReview = yield* readReviewSummary(
						folderId,
						worktreeId,
						"branch",
						observedChanges,
					);
					const fingerprintPaths = observedChanges
						.filter(
							(change) =>
								change.kind !== "deleted" && change.kind !== "ignored",
						)
						.map((change) => change.path);
					const fingerprintObservation =
						yield* observeWorkspaceFingerprintPaths(
							cwd,
							fingerprintPaths,
							(paths) =>
								run(folderId, cwd, [
									"hash-object",
									"--no-filters",
									"--",
									...paths,
								]),
						);
					const localFingerprint = createHash("sha256")
						.update(
							JSON.stringify([
								porcelain,
								observedReview.baseSha,
								observedReview.headSha,
								fingerprintObservation.pathMetadata,
								fingerprintObservation.contentHashes,
								fingerprintObservation.coverageNonce,
							]),
						)
						.digest("hex");
					return {
						status: parseStatusOutput(porcelain),
						changes: observedChanges,
						reviewSummary: observedReview,
						localFingerprint,
					};
				}),
			);

		const reviewPatches: GitService["Service"]["reviewPatches"] = (
			folderId,
			worktreeId,
			scope = "branch",
		) =>
			Stream.unwrap(
				Effect.gen(function* () {
					const cwd = yield* resolvePathForWorktree(folderId, worktreeId);
					const summary = yield* reviewSummary(folderId, worktreeId, scope);
					const comparison = yield* resolveReviewComparison(
						folderId,
						cwd,
						scope,
					);
					return Stream.fromIterable(summary.files).pipe(
						Stream.mapEffect(
							(file) =>
								(file.binary
									? Effect.succeed(
											GitDiffResult.make({
												mode: "binary",
												patch: "",
												truncated: false,
												bytes: 0,
											}),
										)
									: file.kind === "untracked"
										? diff(folderId, file.path, worktreeId)
										: run(folderId, cwd, [
												"diff",
												"--no-color",
												"--no-ext-diff",
												"--find-renames",
												...comparison.args,
												"--",
												file.oldPath ?? file.path,
												file.path,
											]).pipe(
												Effect.map((patch) => {
													const maxBytes = 2_000_000;
													return GitDiffResult.make({
														mode:
															file.kind === "deleted" ? "deleted" : "worktree",
														patch: patch.slice(0, maxBytes),
														truncated: patch.length > maxBytes,
														bytes: patch.length,
													});
												}),
											)
								).pipe(
									Effect.map((result) =>
										GitReviewPatch.make({
											path: file.path,
											result,
											error: null,
										}),
									),
									Effect.catch((cause) =>
										Effect.succeed(
											GitReviewPatch.make({
												path: file.path,
												result: GitDiffResult.make({
													mode: "unchanged",
													patch: "",
													truncated: false,
													bytes: 0,
												}),
												error: String(cause),
											}),
										),
									),
								),
							{ concurrency: 4 },
						),
					);
				}),
			);

		const reviewFileContents: GitService["Service"]["reviewFileContents"] = (
			folderId,
			filePath,
			oldPath,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const range = yield* resolveReviewRange(folderId, cwd);
					const oldContent =
						range.baseSha.length === 0
							? null
							: yield* run(folderId, cwd, [
									"show",
									`${range.baseSha}:${oldPath ?? filePath}`,
								]).pipe(Effect.catch(() => Effect.succeed(null)));
					const absolutePath = path.resolve(cwd, filePath);
					const newContent = yield* fs
						.readFileString(absolutePath)
						.pipe(Effect.catch(() => Effect.succeed(null)));
					const mtime = yield* fs.stat(absolutePath).pipe(
						Effect.map((info) =>
							Option.match(info.mtime, {
								onNone: () => null,
								onSome: (value) => value.toISOString(),
							}),
						),
						Effect.catch(() => Effect.succeed(null)),
					);
					return GitReviewFileContents.make({ oldContent, newContent, mtime });
				}),
			);

		/**
		 * Auto-stage everything tracked + untracked, then create a single commit
		 * with the user's message. Mirrors what the user would do in a basic
		 * "commit all" UI; matches the GitHub Desktop "Commit Tracked + Untracked"
		 * default. Returns the new HEAD sha so the caller can refresh status.
		 */
		const commit: GitService["Service"]["commit"] = (
			folderId,
			message,
			worktreeId,
			paths,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					if (paths !== undefined && paths.length > 0) {
						// Stage + commit only the chosen paths. `git add` handles new and
						// deleted files; the pathspec on `commit` keeps any other staged
						// changes out of this commit.
						yield* run(folderId, cwd, ["add", "--", ...paths]);
						yield* run(folderId, cwd, [
							"commit",
							"-m",
							message,
							"--",
							...paths,
						]);
					} else {
						yield* run(folderId, cwd, ["add", "-A"]);
						yield* run(folderId, cwd, ["commit", "-m", message]);
					}
					const sha = (yield* run(folderId, cwd, ["rev-parse", "HEAD"])).trim();
					return { sha };
				}),
			);

		/**
		 * Push the current branch to its upstream. Sets upstream on first push so
		 * a freshly-created branch lands on origin without an extra step. The
		 * combined stdout+stderr is returned so the renderer can surface it.
		 */
		const push: GitService["Service"]["push"] = (folderId, worktreeId) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					// Fail deterministically before spawning a push when the checkout has no
					// destination. Some Git/process combinations can otherwise report an
					// empty successful result for this invalid operation.
					yield* run(folderId, cwd, ["remote", "get-url", "origin"]);
					const branch = (yield* run(folderId, cwd, [
						"rev-parse",
						"--abbrev-ref",
						"HEAD",
					])).trim();
					if (branch.length === 0 || branch === "HEAD") {
						return yield* Effect.fail(
							new GitCommandError({
								folderId,
								reason: "Cannot push: HEAD is detached.",
							}),
						);
					}
					const out = yield* run(folderId, cwd, [
						"push",
						"--set-upstream",
						"origin",
						branch,
					]);
					return { output: out };
				}),
			);

		const pull: GitService["Service"]["pull"] = (folderId, worktreeId) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const output = yield* run(folderId, cwd, ["pull", "--ff-only"]);
					return { output };
				}),
			);

		const stash: GitService["Service"]["stash"] = (
			folderId,
			message,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const label = message?.trim() || "Zuse mobile stash";
					const output = yield* run(folderId, cwd, [
						"stash",
						"push",
						"--include-untracked",
						"-m",
						label,
					]);
					return {
						created: !output.toLowerCase().includes("no local changes"),
						output,
					};
				}),
			);

		const stashPop: GitService["Service"]["stashPop"] = (
			folderId,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const output = yield* run(folderId, cwd, ["stash", "pop"]);
					return { output };
				}),
			);

		const resetRemotePreview: GitService["Service"]["resetRemotePreview"] = (
			folderId,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const branch = (yield* run(folderId, cwd, [
						"branch",
						"--show-current",
					])).trim();
					if (branch.length === 0) {
						return yield* new GitCommandError({
							folderId,
							reason: "Cannot reset a detached HEAD.",
						});
					}

					yield* run(folderId, cwd, ["fetch", "--prune", "origin"]);
					const upstream = yield* run(folderId, cwd, [
						"rev-parse",
						"--abbrev-ref",
						"--symbolic-full-name",
						"@{upstream}",
					]).pipe(
						Effect.map((value) => value.trim()),
						Effect.catchTag("GitCommandError", () =>
							Effect.succeed(`origin/${branch}`),
						),
					);
					const currentHead = (yield* run(folderId, cwd, [
						"rev-parse",
						"HEAD",
					])).trim();
					const remoteHead = (yield* run(folderId, cwd, [
						"rev-parse",
						upstream,
					])).trim();
					const worktreeState = yield* run(folderId, cwd, [
						"status",
						"--porcelain=v1",
						"-z",
						"--untracked-files=all",
					]);
					const changedPaths = [
						...new Set(
							worktreeState
								.split("\0")
								.filter((entry) => entry.length >= 4)
								.map((entry) => entry.slice(3)),
						),
					];
					const commitsToDiscard = (yield* run(folderId, cwd, [
						"log",
						"--format=%H%x00%s",
						`${remoteHead}..${currentHead}`,
					]))
						.split("\n")
						.filter((line) => line.length > 0)
						.map((line) => {
							const [sha = "", subject = ""] = line.split("\0", 2);
							return { sha, subject };
						});
					const worktreeFingerprint = createHash("sha256")
						.update(worktreeState)
						.digest("hex");

					return GitResetRemotePreview.make({
						branch,
						remoteRef: upstream,
						currentHead,
						remoteHead,
						worktreeFingerprint,
						changedPaths,
						commitsToDiscard,
					});
				}),
			);

		const resetRemoteApply: GitService["Service"]["resetRemoteApply"] = (
			folderId,
			expectedHead,
			expectedRemoteHead,
			expectedWorktreeFingerprint,
			confirmationBranch,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const preview = yield* resetRemotePreview(folderId, worktreeId);
					if (confirmationBranch !== preview.branch) {
						return yield* new GitConfirmationError({
							folderId,
							expectedBranch: preview.branch,
						});
					}
					if (
						expectedHead !== preview.currentHead ||
						expectedRemoteHead !== preview.remoteHead ||
						expectedWorktreeFingerprint !== preview.worktreeFingerprint
					) {
						return yield* new GitStalePreviewError({
							folderId,
							reason:
								"HEAD, the remote branch, or the worktree changed after preview.",
						});
					}

					return yield* commandLock(cwd).withPermits(1)(
						Effect.gen(function* () {
							const currentHead = (yield* runUnlocked(folderId, cwd, [
								"rev-parse",
								"HEAD",
							])).trim();
							const remoteHead = (yield* runUnlocked(folderId, cwd, [
								"rev-parse",
								preview.remoteRef,
							])).trim();
							const worktreeState = yield* runUnlocked(folderId, cwd, [
								"status",
								"--porcelain=v1",
								"-z",
								"--untracked-files=all",
							]);
							const fingerprint = createHash("sha256")
								.update(worktreeState)
								.digest("hex");
							if (
								currentHead !== preview.currentHead ||
								remoteHead !== preview.remoteHead ||
								fingerprint !== preview.worktreeFingerprint
							) {
								return yield* new GitStalePreviewError({
									folderId,
									reason:
										"HEAD, the remote branch, or the worktree changed immediately before reset.",
								});
							}
							yield* runUnlocked(folderId, cwd, [
								"reset",
								"--hard",
								preview.remoteRef,
							]);
							yield* runUnlocked(folderId, cwd, ["clean", "-fd"]);
							const head = (yield* runUnlocked(folderId, cwd, [
								"rev-parse",
								"HEAD",
							])).trim();
							return { head };
						}),
					);
				}),
			);

		/**
		 * Persist a resolved merge-conflict file: write the marker-free contents
		 * the renderer's `UnresolvedFile` produced, then `git add` the path so it
		 * leaves the unmerged state.
		 */
		const resolveConflict: GitService["Service"]["resolveConflict"] = (
			folderId,
			relPath,
			contents,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					if (/^(?:<<<<<<<|>>>>>>>)(?: .*)?\r?$/m.test(contents)) {
						return yield* Effect.fail(
							new GitCommandError({
								folderId,
								reason:
									"Cannot mark the file resolved while merge-conflict markers remain.",
							}),
						);
					}
					const abs = path.resolve(cwd, relPath);
					yield* fs.writeFileString(abs, contents).pipe(
						Effect.mapError(
							(cause) =>
								new GitCommandError({
									folderId,
									reason: cause.message ?? String(cause),
								}),
						),
					);
					yield* run(folderId, cwd, ["add", "--", relPath]);
					return {};
				}),
			);

		/** Read fresh action state and bind merge/auto-merge to the checkout's head. */
		const mergePr: GitService["Service"]["mergePr"] = (
			folderId,
			action,
			method,
			deleteBranch,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const current = yield* currentPr(folderId, cwd, { force: true });
					if (!current)
						return yield* Effect.fail(
							new GitCommandError({
								folderId,
								reason: "No pull request is available for this branch.",
							}),
						);
					const { repository, pr } = current;
					return yield* commandLock(cwd).withPermits(1)(
						Effect.gen(function* () {
							const branch = (yield* runUnlocked(folderId, cwd, [
								"rev-parse",
								"--abbrev-ref",
								"HEAD",
							])).trim();
							if (branch !== current.branch)
								return yield* Effect.fail(
									new GitCommandError({
										folderId,
										reason:
											"The checkout branch changed. Refresh before merging.",
									}),
								);
							const localHead = (yield* runUnlocked(folderId, cwd, [
								"rev-parse",
								"HEAD",
							])).trim();
							if (action !== "disable-auto" && localHead !== pr.headRefOid)
								return yield* Effect.fail(
									new GitCommandError({
										folderId,
										reason:
											"The PR head differs from this checkout. Sync the branch before merging.",
									}),
								);
							const merged = yield* githubEffect(folderId, async (signal) => {
								const credential = await github.credential(repository, signal);
								const arm =
									action !== "disable-auto" &&
									(pr.isMergeQueueEnabled ||
										(action === "enable-auto" &&
											!["CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(
												pr.mergeStateStatus,
											)));
								const mutation =
									action === "disable-auto"
										? "disablePullRequestAutoMerge"
										: arm
											? "enablePullRequestAutoMerge"
											: "mergePullRequest";
								const input: Record<string, unknown> = { pullRequestId: pr.id };
								if (action !== "disable-auto") {
									input.mergeMethod = method.toUpperCase();
									input.expectedHeadOid = localHead;
								}
								await github.graphql(
									credential,
									`mutation($input:${mutation[0]?.toUpperCase()}${mutation.slice(1)}Input!) { ${mutation}(input:$input) { pullRequest { id } } }`,
									{ input },
									signal,
								);
								return !arm && action !== "disable-auto";
							});
							pullRequests.invalidate();
							let remoteBranchDeleted = true;
							// Branch deletion follows confirmed immediate merge only, never an armed queue.
							if (
								merged &&
								deleteBranch &&
								!pr.isCrossRepository &&
								pr.viewerCanDeleteHeadRef
							) {
								remoteBranchDeleted = yield* githubEffect(
									folderId,
									async (signal) => {
										const credential = await github.credential(
											repository,
											signal,
										);
										await github.rest(
											credential,
											`repos/${repository.owner}/${repository.repo}/git/refs/heads/${encodeURIComponent(pr.headRefName)}`,
											signal,
											{ method: "DELETE", interactive: true },
										);
									},
								).pipe(
									Effect.as(true),
									Effect.catch(() => Effect.succeed(false)),
								);
								const base =
									pr.headRepository?.defaultBranchRef?.name ?? pr.baseRefName;
								if (
									base !== pr.headRefName &&
									!(yield* runUnlocked(folderId, cwd, [
										"status",
										"--porcelain",
									])).trim()
								) {
									yield* runUnlocked(folderId, cwd, ["switch", base]);
									const remotes = (yield* runUnlocked(folderId, cwd, [
										"remote",
									]))
										.trim()
										.split("\n");
									let remote: string | undefined;
									for (const name of remotes) {
										const origin = parseRemoteUrl(
											(yield* runUnlocked(folderId, cwd, [
												"remote",
												"get-url",
												name,
											])).trim(),
										);
										if (
											origin?.host === repository.host &&
											origin.owner === repository.owner &&
											origin.repo === repository.repo
										) {
											remote = name;
											break;
										}
									}
									if (!remote)
										return {
											output: remoteBranchDeleted
												? "Pull request merged; no matching remote for local branch cleanup."
												: "Pull request merged; remote branch deletion failed and no matching remote is available for local cleanup.",
										};
									yield* runUnlocked(folderId, cwd, ["fetch", remote, base]);
									yield* runUnlocked(folderId, cwd, [
										"merge",
										"--ff-only",
										`${remote}/${base}`,
									]);
									yield* runUnlocked(folderId, cwd, [
										"branch",
										"-d",
										pr.headRefName,
									]);
								}
							}
							return {
								output:
									action === "disable-auto"
										? "Auto-merge disabled."
										: merged
											? remoteBranchDeleted
												? "Pull request merged."
												: "Pull request merged; the remote branch could not be deleted."
											: "Auto-merge enabled.",
							};
						}),
					);
				}),
			);

		const markReady: GitService["Service"]["markReady"] = (
			folderId,
			worktreeId,
			state = "ready",
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const current = yield* currentPr(folderId, cwd, { force: true });
					if (!current)
						return yield* Effect.fail(
							new GitCommandError({
								folderId,
								reason: "No pull request is available for this branch.",
							}),
						);
					const mutation =
						state === "draft"
							? "convertPullRequestToDraft"
							: state === "closed"
								? "closePullRequest"
								: state === "open"
									? "reopenPullRequest"
									: "markPullRequestReadyForReview";
					yield* githubEffect(folderId, async (signal) => {
						const credential = await github.credential(
							current.repository,
							signal,
						);
						await github.graphql(
							credential,
							`mutation($input:${mutation[0]?.toUpperCase()}${mutation.slice(1)}Input!) { ${mutation}(input:$input) { pullRequest { id } } }`,
							{ input: { pullRequestId: current.pr.id } },
							signal,
						);
					});
					pullRequests.invalidate();
					return { output: "Pull request updated." };
				}),
			);

		/**
		 * Initialize a fresh git repo in a folder that has none — backs the
		 * Changes tab's "not a Git repository" CTA. Defaults the initial branch to
		 * `main` so it matches the rest of the app's expectations (commit composer,
		 * push). Returns the branch name for the UI to confirm.
		 */
		const init: GitService["Service"]["init"] = (folderId) =>
			Effect.flatMap(resolvePath(folderId), (cwd) =>
				run(folderId, cwd, ["init", "-b", "main"]).pipe(
					Effect.as({ branch: "main" }),
				),
			);

		/**
		 * Discard a single file's uncommitted changes. Untracked files are
		 * deleted from disk (`git clean -f`); everything else is restored from
		 * HEAD in both the index and the working tree (`git restore --staged
		 * --worktree`). For renames the original path is restored too, so a
		 * `foo → bar` move reverts the deletion of `foo` as well as `bar`.
		 */
		const revertFile: GitService["Service"]["revertFile"] = (
			folderId,
			path,
			kind,
			oldPath,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					if (kind === "untracked") {
						yield* run(folderId, cwd, ["clean", "-f", "--", path]);
					} else {
						yield* run(folderId, cwd, [
							"restore",
							"--staged",
							"--worktree",
							"--",
							path,
						]);
						if (
							typeof oldPath === "string" &&
							oldPath.length > 0 &&
							oldPath !== path
						) {
							yield* run(folderId, cwd, [
								"restore",
								"--staged",
								"--worktree",
								"--",
								oldPath,
							]);
						}
					}
					return { reverted: true };
				}),
			);

		/**
		 * Discard every uncommitted change: hard-reset tracked files to HEAD,
		 * then remove all untracked files and directories. Destructive and
		 * unrecoverable — gated behind a confirm dialog in the renderer.
		 */
		const revertAll: GitService["Service"]["revertAll"] = (
			folderId,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					yield* run(folderId, cwd, ["reset", "--hard", "HEAD"]);
					yield* run(folderId, cwd, ["clean", "-fd"]);
					return { reverted: true };
				}),
			);

		const restoreFileToBase: GitService["Service"]["restoreFileToBase"] = (
			folderId,
			filePath,
			oldPath,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const range = yield* resolveReviewRange(folderId, cwd);
					if (range.baseSha.length === 0) return { restored: false };
					const targets = [filePath, oldPath].filter(
						(value, index, all): value is string =>
							typeof value === "string" &&
							value.length > 0 &&
							all.indexOf(value) === index,
					);
					for (const target of targets) {
						const absoluteTarget = path.resolve(cwd, target);
						const relativeTarget = path.relative(cwd, absoluteTarget);
						if (
							relativeTarget.startsWith("..") ||
							path.isAbsolute(relativeTarget)
						) {
							return yield* new GitCommandError({
								folderId,
								reason: `Path is outside the worktree: ${target}`,
							});
						}
						const existsAtBase = yield* run(folderId, cwd, [
							"cat-file",
							"-e",
							`${range.baseSha}:${relativeTarget}`,
						]).pipe(
							Effect.as(true),
							Effect.catch(() => Effect.succeed(false)),
						);
						if (existsAtBase) {
							yield* run(folderId, cwd, [
								"restore",
								"--source",
								range.baseSha,
								"--worktree",
								"--",
								relativeTarget,
							]);
						} else {
							yield* fs
								.remove(absoluteTarget, { recursive: true, force: true })
								.pipe(
									Effect.mapError(
										(error) =>
											new GitCommandError({
												folderId,
												reason: `remove ${relativeTarget}: ${String(error)}`,
											}),
									),
								);
						}
					}
					return { restored: true };
				}),
			);

		/**
		 * Capture logs from every failing GitHub Actions run on the current PR
		 * and drop them in `<worktree>/.zuse/failing-checks-<ts>.txt` so the
		 * renderer can attach the file to the composer (`@.zuse/...txt`) and
		 * ask the agent to fix it.
		 *
		 * Core checks identify failed jobs. Their logs are read directly from the
		 * Actions API, with signed storage redirects fetched without credentials.
		 */
		const fixFailingChecks: GitService["Service"]["fixFailingChecks"] = (
			folderId,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const current = yield* currentPr(folderId, cwd, { force: true });
					if (!current)
						return yield* Effect.fail(
							new GitCommandError({
								folderId,
								reason: "No pull request is available for this branch.",
							}),
						);
					const rollup = current.pr.statusCheckRollup;
					const failing = rollup.filter(isFailedCheckRollup);

					// Map each failing check to its workflow-run ID. gh emits two URL
					// shapes: actions runs (`/actions/runs/<id>/job/<jobId>`) and
					// external check URLs (no run id). Skip the latter — we can't
					// pull logs for them.
					const runIds = new Set<string>();
					const failingNames: Array<string> = [];
					for (const c of failing) {
						failingNames.push(c.name ?? "(unnamed)");
						const url = c.detailsUrl ?? c.targetUrl ?? "";
						const m = /\/actions\/runs\/(\d+)/.exec(url);
						if (m !== null && m[1] !== undefined) runIds.add(m[1]);
					}

					const sections: Array<string> = [];
					for (const id of runIds) {
						const log = yield* githubEffect(folderId, async (signal) => {
							const credential = await github.credential(
								current.repository,
								signal,
							);
							const root = `repos/${current.repository.owner}/${current.repository.repo}`;
							const jobs = await github.pages<ActionsJob>(
								credential,
								`${root}/actions/runs/${id}/jobs`,
								signal,
								(value) => (value as { jobs: ActionsJob[] }).jobs,
							);
							const logs: string[] = [];
							for (const job of jobs.filter((job) =>
								isFailedCheckRollup({
									conclusion: job.conclusion ?? undefined,
								}),
							)) {
								const response = await github.request({
									credential,
									api: "rest",
									path: `${root}/actions/jobs/${job.id}/logs`,
									signal,
									interactive: true,
								});
								if (response.status >= 300 && response.status < 400)
									throw new GitHubFailure(
										"unknown",
										"GitHub log redirect was not resolved.",
									);
								logs.push(`--- ${job.name ?? "job"} ---\n${response.body}`);
							}
							return logs.join("\n");
						}).pipe(
							Effect.catchTag("GitCommandError", (error) =>
								Effect.succeed(
									`(failed to fetch logs for run ${id}: ${error.reason})\n`,
								),
							),
						);
						sections.push(`==== run ${id} ====\n${log.trim()}\n`);
					}

					const header =
						failingNames.length === 0
							? "No failing checks found.\n"
							: `Failing checks (${failingNames.length}):\n` +
								failingNames.map((n) => `  - ${n}`).join("\n") +
								"\n";
					const body =
						sections.length > 0
							? sections.join("\n")
							: "(no actions run logs available — checks may be external or pending)\n";

					const dir = path.join(cwd, ".zuse");
					yield* fs.makeDirectory(dir, { recursive: true }).pipe(
						Effect.catch((err) =>
							Effect.fail(
								new GitCommandError({
									folderId,
									reason: `failed to create .zuse/: ${String(err)}`,
								}),
							),
						),
					);

					// Filesystem-safe ISO-ish timestamp (drop sub-second precision +
					// colons that break some shells).
					const ts = (yield* DateTime.nowAsDate)
						.toISOString()
						.replace(/[:.]/g, "-")
						.replace(/-\d{3}Z$/, "Z");
					const fileName = `failing-checks-${ts}.txt`;
					const absPath = path.join(dir, fileName);
					const relPath = `.zuse/${fileName}`;

					yield* fs.writeFileString(absPath, `${header}\n${body}`).pipe(
						Effect.catch((err) =>
							Effect.fail(
								new GitCommandError({
									folderId,
									reason: `failed to write ${relPath}: ${String(err)}`,
								}),
							),
						),
					);

					return GitFailingChecksArtifact.make({
						relPath,
						absPath,
						failingCount: failingNames.length,
					});
				}),
			);

		// One filesystem-backed invalidation source per checkout. The shared
		// wrapper below fans it out to every retained consumer without multiplying
		// filesystem watchers or reconciliation pollers.
		// The watcher is forked before revision zero is offered: receiving the
		// initial frame is the client's barrier that it may safely read a snapshot.
		const workspaceChangesSource: GitService["Service"]["workspaceChanges"] = (
			folderId,
			worktreeId,
		) =>
			Stream.unwrap(
				Effect.gen(function* () {
					const mailbox = yield* Queue.sliding<{ readonly revision: number }>(
						1,
					);
					let revision = 0;
					let watching = false;
					let quietTicks = 0;
					const emitRevision = Effect.sync(() => {
						quietTicks = 0;
						revision += 1;
						Queue.offerUnsafe(mailbox, { revision });
					});
					const watchOnce = Effect.gen(function* () {
						const cwd = yield* resolvePathForWorktree(folderId, worktreeId);
						const [gitDirectoryOutput, commonDirectoryOutput] =
							yield* Effect.all([
								run(folderId, cwd, ["rev-parse", "--absolute-git-dir"]),
								run(folderId, cwd, ["rev-parse", "--git-common-dir"]),
							]);
						const absoluteMetadataPath = (value: string): string => {
							const trimmed = value.trim();
							return path.isAbsolute(trimmed)
								? trimmed
								: path.resolve(cwd, trimmed);
						};
						const watchPaths = [
							cwd,
							absoluteMetadataPath(gitDirectoryOutput),
							absoluteMetadataPath(commonDirectoryOutput),
						].filter((value, index, values) => values.indexOf(value) === index);
						watching = true;
						yield* Stream.mergeAll(
							watchPaths.map((watchPath) => fs.watch(watchPath)),
							{ concurrency: "unbounded" },
						).pipe(
							Stream.debounce(Duration.millis(50)),
							Stream.runForEach(() => emitRevision),
							Effect.ensuring(
								Effect.sync(() => {
									watching = false;
								}),
							),
						);
					});

					// Native watchers are an optimization. Checkout lookup, Git metadata
					// discovery, and the watch itself can all fail while a folder is being
					// created, initialized, moved, or restored. Retry that complete setup on
					// a bounded cadence; a cleanly ended watcher
					// sleeps too, so no failure mode can spin.
					yield* Effect.forkScoped(
						Effect.forever(
							watchOnce.pipe(
								Effect.catch(() => Effect.void),
								Effect.andThen(Effect.sleep(Duration.seconds(5))),
							),
						),
					);
					// Native recursive events handle edits promptly. Reconcile quiet
					// checkouts every 30s; keep 5s recovery when watching is unavailable.
					yield* Effect.forkScoped(
						Effect.forever(
							Effect.sleep(Duration.seconds(5)).pipe(
								Effect.andThen(
									Effect.suspend(() => {
										quietTicks += 1;
										return !watching || quietTicks >= 6
											? emitRevision
											: Effect.void;
									}),
								),
							),
						),
					);
					// Let the scoped watcher install before publishing the initial barrier.
					yield* Effect.yieldNow;
					Queue.offerUnsafe(mailbox, { revision });

					return Stream.fromQueue(mailbox).pipe(
						// A build can emit thousands of events. Retain only the latest
						// pending invalidation and bound automatic snapshots to 1/s.
						Stream.throttle({
							cost: (entries) => entries.length,
							units: 1,
							duration: "1 second",
							strategy: "shape",
						}),
					);
				}),
			);
		const workspaceChangeStreams = yield* makeWorkspaceChangeStreams(
			workspaceChangesSource,
		);
		const workspaceChanges: GitService["Service"]["workspaceChanges"] = (
			folderId,
			worktreeId,
		) => workspaceChangeStreams.stream(folderId, worktreeId ?? null);

		return {
			isRepository,
			ignoredDirectories,
			log,
			status,
			branches,
			switchBranch,
			stack,
			renameBranch,
			getUserName,
			workspaceChanges,
			workspaceSnapshot,
			origin,
			prState,
			prDetails,
			createReviewComment,
			reviewIdentity,
			listPrs,
			listIssues,
			issueMarkdown,
			changes,
			diff,
			reviewSummary,
			reviewPatches,
			reviewFileContents,
			commit,
			push,
			pull,
			stash,
			stashPop,
			resetRemotePreview,
			resetRemoteApply,
			resolveConflict,
			mergePr,
			markReady,
			init,
			revertFile,
			revertAll,
			restoreFileToBase,
			fixFailingChecks,
		} as const;
	}),
);
