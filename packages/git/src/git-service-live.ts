import {
	type FolderId,
	GitBranchInfo,
	GitChange,
	type GitChangeKind,
	GitCommandError,
	GitCommit,
	type GitDiffMode,
	GitDiffResult,
	GitFailingChecksArtifact,
	type GitFolderNotFoundError,
	GitIssueSummary,
	GitNotARepoError,
	GitNotInstalledError,
	GitOriginInfo,
	GitPrCheckRun,
	type GitPrCheckRunConclusion,
	type GitPrCheckRunStatus,
	GitPrComment,
	GitPrDetails,
	GitPrFile,
	GitPrInfo,
	GitPrReview,
	type GitPrReviewState,
	GitPrSummary,
	GitReviewFile,
	GitReviewFileContents,
	GitReviewPatch,
	GitReviewSummary,
	GitStatusSummary,
} from "@zuse/contracts";
import {
	type ActionsJob,
	actionsJobsApiPath,
	collectActionsRunIds,
	metadataForRollupEntry,
	type PrCheckRollupEntry,
	parseActionsJobsResponse,
} from "@zuse/git/check-runs";
import { GitService } from "@zuse/git/git-service";
import {
	Cause,
	DateTime,
	Duration,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Queue,
	Ref,
	Schedule,
	Stream,
} from "effect";
import {
	ChildProcess as Command,
	ChildProcessSpawner as CommandExecutor,
} from "effect/unstable/process";
import { RepositoryLocator } from "./repository-locator.ts";

type GitFailure =
	| GitNotARepoError
	| GitNotInstalledError
	| GitCommandError
	| GitFolderNotFoundError;

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
const parseRemoteUrl = (url: string): GitOriginInfo | null => {
	const cleaned = url.replace(/\.git$/, "");
	const scp = /^[\w.-]+@([\w.-]+):([\w.-]+)\/([\w.-]+)$/.exec(cleaned);
	if (scp) {
		const [, host, owner, repo] = scp;
		if (host !== undefined && owner !== undefined && repo !== undefined) {
			return GitOriginInfo.make({ host, owner, repo });
		}
	}
	const proto =
		/^(?:https?|ssh):\/\/(?:[\w.-]+@)?([\w.-]+)\/([\w.-]+)\/([\w.-]+)$/.exec(
			cleaned,
		);
	if (proto) {
		const [, host, owner, repo] = proto;
		if (host !== undefined && owner !== undefined && repo !== undefined) {
			return GitOriginInfo.make({ host, owner, repo });
		}
	}
	return null;
};

const githubAvatarUrl = (login: string | undefined): string | null => {
	if (login === undefined || login.trim().length === 0) return null;
	return `https://github.com/${encodeURIComponent(login.trim())}.png?size=40`;
};

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
		if (
			conclusion === "FAILURE" ||
			conclusion === "CANCELLED" ||
			conclusion === "TIMED_OUT" ||
			conclusion === "ACTION_REQUIRED" ||
			state === "FAILURE" ||
			state === "ERROR"
		) {
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
		if (
			conclusion === "FAILURE" ||
			conclusion === "CANCELLED" ||
			conclusion === "TIMED_OUT" ||
			conclusion === "ACTION_REQUIRED" ||
			state === "FAILURE" ||
			state === "ERROR"
		) {
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

		const run = (
			folderId: FolderId,
			cwd: string,
			args: ReadonlyArray<string>,
		) =>
			Effect.scoped(
				Effect.gen(function* () {
					const cmd = Command.make("git", args, { cwd });
					const proc = yield* executor.spawn(cmd);
					const stdout = yield* collectText(proc.stdout);
					const stderr = yield* collectText(proc.stderr);
					const exitCode = yield* proc.exitCode;
					if (exitCode === 0) return stdout;
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

		const log: GitService["Service"]["log"] = (folderId, limit) =>
			Effect.flatMap(resolvePath(folderId), (cwd) =>
				run(folderId, cwd, [
					"log",
					`-${Math.max(1, Math.floor(limit))}`,
					`--pretty=format:${LOG_FORMAT}`,
				]).pipe(Effect.map(parseLogOutput)),
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
					]).pipe(Effect.catchTag("GitCommandError", () => Effect.succeed("")));
					return parseBranchRows(localOut, remoteOut);
				}),
			);

		const switchBranch: GitService["Service"]["switchBranch"] = (
			folderId,
			branch,
			remote,
			worktreeId,
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
					if (remoteTarget.length > 0) {
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

		const headSha = (folderId: FolderId) =>
			Effect.flatMap(resolvePath(folderId), (cwd) =>
				run(folderId, cwd, ["rev-parse", "HEAD"]).pipe(
					Effect.map((s) => s.trim()),
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

		// Run `gh ...` in `cwd`. Same shape as `run` but uses the GitHub CLI.
		// Missing `gh` (ENOENT) maps to GitNotInstalled — the caller catches it
		// and falls back to "no PR" so the renderer doesn't pop an error toast on
		// machines without `gh`.
		const ghRun = (
			folderId: FolderId,
			cwd: string,
			args: ReadonlyArray<string>,
		) =>
			Effect.scoped(
				Effect.gen(function* () {
					const cmd = Command.make("gh", args, { cwd });
					const proc = yield* executor.spawn(cmd);
					const stdout = yield* collectText(proc.stdout);
					const stderr = yield* collectText(proc.stderr);
					const exitCode = yield* proc.exitCode;
					if (exitCode === 0) return stdout;
					return yield* Effect.fail(
						new GitCommandError({
							folderId,
							reason: stderr.trim() || `gh exited with code ${exitCode}`,
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

		const currentPrView = (
			folderId: FolderId,
			cwd: string,
			fields: string,
		): Effect.Effect<string, GitNotInstalledError | GitCommandError> =>
			Effect.gen(function* () {
				const read = (candidate: string | null) =>
					ghRun(
						folderId,
						cwd,
						candidate === null
							? ["pr", "view", "--json", fields]
							: ["pr", "view", candidate, "--json", fields],
					).pipe(Effect.catchTag("GitCommandError", () => Effect.succeed("")));

				const direct = yield* read(null);
				if (direct.trim().length > 0) return direct;

				const candidates: string[] = [];
				const addCandidate = (value: string) => {
					const candidate = value.trim();
					if (
						candidate.length === 0 ||
						candidate === "HEAD" ||
						candidates.includes(candidate)
					) {
						return;
					}
					candidates.push(candidate);
				};
				const addRefCandidate = (value: string) => {
					const ref = value.trim();
					addCandidate(ref);
					const slash = ref.indexOf("/");
					if (slash !== -1) addCandidate(ref.slice(slash + 1));
				};

				const branch = yield* run(folderId, cwd, [
					"rev-parse",
					"--abbrev-ref",
					"HEAD",
				]).pipe(
					Effect.catchTags({
						GitCommandError: () => Effect.succeed(""),
						GitNotARepoError: () => Effect.succeed(""),
					}),
				);
				addRefCandidate(branch);

				const upstream = yield* run(folderId, cwd, [
					"rev-parse",
					"--abbrev-ref",
					"--symbolic-full-name",
					"@{upstream}",
				]).pipe(
					Effect.catchTags({
						GitCommandError: () => Effect.succeed(""),
						GitNotARepoError: () => Effect.succeed(""),
					}),
				);
				addRefCandidate(upstream);

				for (const candidate of candidates) {
					const stdout = yield* read(candidate);
					if (stdout.trim().length > 0) return stdout;
				}
				return "";
			});

		const prState: GitService["Service"]["prState"] = (folderId, worktreeId) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const empty: GitPrInfo = GitPrInfo.make({
						state: "none",
						branch: null,
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
					});

					const stdout = yield* currentPrView(
						folderId,
						cwd,
						"state,additions,deletions,number,url,headRefName,baseRefName,isDraft,statusCheckRollup,mergeable,autoMergeRequest",
					).pipe(
						Effect.catchTags({
							GitNotInstalledError: () => Effect.succeed(""),
							GitCommandError: () => Effect.succeed(""),
						}),
					);

					if (stdout.trim().length === 0) return empty;

					let parsed: {
						state?: string;
						additions?: number;
						deletions?: number;
						number?: number;
						url?: string;
						headRefName?: string;
						baseRefName?: string;
						isDraft?: boolean;
						mergeable?: string;
						autoMergeRequest?: unknown;
						statusCheckRollup?: ReadonlyArray<{
							status?: string;
							state?: string;
							conclusion?: string;
						}>;
					};
					try {
						parsed = JSON.parse(stdout) as typeof parsed;
					} catch {
						return empty;
					}

					// gh returns "OPEN" / "CLOSED" / "MERGED"; map to the wire literal.
					const raw = (parsed.state ?? "").toLowerCase();
					const state: GitPrInfo["state"] =
						raw === "open"
							? "open"
							: raw === "merged"
								? "merged"
								: raw === "closed"
									? "closed"
									: "none";

					// statusCheckRollup is a heterogeneous array — gh actions use
					// `status` + `conclusion`, external checks use `state`. We collapse
					// both into a four-state aggregate.
					const rollup = parsed.statusCheckRollup ?? [];
					const checks: GitPrInfo["checks"] = aggregateChecks(rollup);
					const counts = countChecks(rollup);

					return GitPrInfo.make({
						state,
						branch: parsed.headRefName ?? null,
						baseBranch: parsed.baseRefName ?? null,
						additions:
							typeof parsed.additions === "number" ? parsed.additions : 0,
						deletions:
							typeof parsed.deletions === "number" ? parsed.deletions : 0,
						number: typeof parsed.number === "number" ? parsed.number : null,
						url: parsed.url ?? null,
						isDraft: parsed.isDraft === true,
						checks,
						mergeable: mapMergeable(parsed.mergeable),
						checksTotal: counts.total,
						checksRunning: counts.running,
						checksPassing: counts.passing,
						checksFailing: counts.failing,
						// gh emits `autoMergeRequest: null` when no auto-merge is queued,
						// and an object describing the pending merge when one is.
						autoMergeEnabled:
							parsed.autoMergeRequest !== null &&
							parsed.autoMergeRequest !== undefined,
					});
				}),
			);

		// Map gh's review state vocabulary (`APPROVED`, `CHANGES_REQUESTED`, ...)
		// to the wire's lowercase literal. Anything we don't recognize collapses
		// to "commented" — gh sometimes emits review entries with no state when
		// the review is just inline comments without a top-level summary verdict.
		const mapReviewState = (raw: string): GitPrReviewState => {
			switch (raw.toUpperCase()) {
				case "APPROVED":
					return "approved";
				case "CHANGES_REQUESTED":
					return "changes_requested";
				case "DISMISSED":
					return "dismissed";
				case "PENDING":
					return "pending";
				default:
					return "commented";
			}
		};

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

		const mapCheckStatus = (raw: string): GitPrCheckRunStatus => {
			switch (raw.toUpperCase()) {
				case "QUEUED":
					return "queued";
				case "IN_PROGRESS":
					return "in_progress";
				case "COMPLETED":
					return "completed";
				default:
					return "pending";
			}
		};

		const mapCheckConclusion = (
			raw: string,
		): GitPrCheckRunConclusion | null => {
			switch (raw.toUpperCase()) {
				case "SUCCESS":
					return "success";
				case "FAILURE":
				case "ERROR":
					return "failure";
				case "CANCELLED":
					return "cancelled";
				case "SKIPPED":
					return "skipped";
				case "NEUTRAL":
					return "neutral";
				case "TIMED_OUT":
					return "timed_out";
				case "ACTION_REQUIRED":
					return "action_required";
				default:
					return null;
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

		const prDetails: GitService["Service"]["prDetails"] = (
			folderId,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const stdout = yield* currentPrView(
						folderId,
						cwd,
						"state,additions,deletions,number,url,headRefName,baseRefName,isDraft,statusCheckRollup,title,body,author,comments,reviews,files,mergeable",
					).pipe(
						Effect.catchTags({
							GitNotInstalledError: () => Effect.succeed(""),
							GitCommandError: () => Effect.succeed(""),
						}),
					);

					if (stdout.trim().length === 0) return emptyDetails;

					let parsed: {
						state?: string;
						additions?: number;
						deletions?: number;
						number?: number;
						url?: string;
						headRefName?: string;
						baseRefName?: string;
						isDraft?: boolean;
						mergeable?: string;
						title?: string;
						body?: string;
						author?: { login?: string };
						comments?: ReadonlyArray<{
							author?: { login?: string; avatarUrl?: string };
							body?: string;
							createdAt?: string;
						}>;
						reviews?: ReadonlyArray<{
							author?: { login?: string; avatarUrl?: string };
							state?: string;
							body?: string;
							submittedAt?: string | null;
						}>;
						files?: ReadonlyArray<{
							path?: string;
							additions?: number;
							deletions?: number;
						}>;
						statusCheckRollup?: ReadonlyArray<PrCheckRollupEntry>;
					};
					try {
						parsed = JSON.parse(stdout) as typeof parsed;
					} catch {
						return emptyDetails;
					}

					const raw = (parsed.state ?? "").toLowerCase();
					const state: GitPrInfo["state"] =
						raw === "open"
							? "open"
							: raw === "merged"
								? "merged"
								: raw === "closed"
									? "closed"
									: "none";

					const rollup = parsed.statusCheckRollup ?? [];
					const checks = aggregateChecks(rollup);
					const originInfo = yield* run(folderId, cwd, [
						"remote",
						"get-url",
						"origin",
					]).pipe(
						Effect.map((s) => parseRemoteUrl(s.trim())),
						Effect.catchTag("GitCommandError", () => Effect.succeed(null)),
					);
					const jobsByRunId = new Map<string, ReadonlyArray<ActionsJob>>();
					if (originInfo?.host.toLowerCase() === "github.com") {
						for (const runId of collectActionsRunIds(rollup)) {
							const jobsStdout = yield* ghRun(folderId, cwd, [
								"api",
								actionsJobsApiPath(originInfo.owner, originInfo.repo, runId),
							]).pipe(
								Effect.catchTags({
									GitNotInstalledError: () => Effect.succeed(""),
									GitCommandError: () => Effect.succeed(""),
								}),
							);
							jobsByRunId.set(runId, parseActionsJobsResponse(jobsStdout));
						}
					}

					const checkRuns = rollup.map((c) => {
						const metadata = metadataForRollupEntry(c, jobsByRunId);
						return GitPrCheckRun.make({
							name: c.name ?? "(unnamed check)",
							// External "state" checks don't have a separate `status` field;
							// treat them as completed with the state mapped via conclusion.
							status: mapCheckStatus(
								c.status ?? (c.state !== undefined ? "completed" : "pending"),
							),
							conclusion: mapCheckConclusion(
								c.conclusion !== undefined && c.conclusion.length > 0
									? c.conclusion
									: (c.state ?? ""),
							),
							url: c.detailsUrl ?? c.targetUrl ?? null,
							workflowName: metadata.workflowName,
							runId: metadata.runId,
							jobId: metadata.jobId,
							runnerName: metadata.runnerName,
							runnerGroupName: metadata.runnerGroupName,
							startedAt: metadata.startedAt,
							completedAt: metadata.completedAt,
							runUrl: metadata.runUrl,
						});
					});

					const comments = (parsed.comments ?? [])
						.filter((c) => typeof c.createdAt === "string")
						.map((c) => {
							const author = c.author?.login ?? "";
							return GitPrComment.make({
								author,
								authorAvatarUrl: c.author?.avatarUrl ?? githubAvatarUrl(author),
								body: c.body ?? "",
								createdAt: new Date(c.createdAt as string),
							});
						});

					const reviews = (parsed.reviews ?? []).map((r) => {
						const author = r.author?.login ?? "";
						return GitPrReview.make({
							author,
							authorAvatarUrl: r.author?.avatarUrl ?? githubAvatarUrl(author),
							state: mapReviewState(r.state ?? ""),
							body: r.body ?? "",
							submittedAt:
								typeof r.submittedAt === "string" && r.submittedAt.length > 0
									? new Date(r.submittedAt)
									: null,
						});
					});

					const files = (parsed.files ?? [])
						.filter((f) => typeof f.path === "string" && f.path.length > 0)
						.map((f) =>
							GitPrFile.make({
								path: f.path as string,
								additions: typeof f.additions === "number" ? f.additions : 0,
								deletions: typeof f.deletions === "number" ? f.deletions : 0,
							}),
						);

					return GitPrDetails.make({
						state,
						number: typeof parsed.number === "number" ? parsed.number : null,
						url: parsed.url ?? null,
						isDraft: parsed.isDraft === true,
						checks,
						mergeable: mapMergeable(parsed.mergeable),
						additions:
							typeof parsed.additions === "number" ? parsed.additions : 0,
						deletions:
							typeof parsed.deletions === "number" ? parsed.deletions : 0,
						title: parsed.title ?? "",
						body: parsed.body ?? "",
						author: parsed.author?.login ?? "",
						baseBranch: parsed.baseRefName ?? null,
						headBranch: parsed.headRefName ?? null,
						comments,
						reviews,
						files,
						checkRuns,
					});
				}),
			);

		// Shared helper: run a `gh` JSON-list command in the folder's checkout and
		// collapse every failure mode (no gh, no auth, no GitHub remote, bad JSON)
		// to an empty array. The "Create from…" picker shows an empty tab rather
		// than an error toast on machines/repos without GitHub.
		const ghJsonList = <T>(folderId: FolderId, args: ReadonlyArray<string>) =>
			Effect.flatMap(resolvePathForWorktree(folderId, null), (cwd) =>
				ghRun(folderId, cwd, args).pipe(
					Effect.catchTags({
						GitNotInstalledError: () => Effect.succeed(""),
						GitCommandError: () => Effect.succeed(""),
					}),
					Effect.map((stdout): ReadonlyArray<T> => {
						if (stdout.trim().length === 0) return [];
						try {
							const parsed = JSON.parse(stdout) as unknown;
							return Array.isArray(parsed) ? (parsed as ReadonlyArray<T>) : [];
						} catch {
							return [];
						}
					}),
				),
			);

		const listPrs: GitService["Service"]["listPrs"] = (folderId) =>
			ghJsonList<{
				number?: number;
				title?: string;
				author?: { login?: string };
				headRefName?: string;
				isDraft?: boolean;
				state?: string;
				updatedAt?: string;
			}>(folderId, [
				"pr",
				"list",
				"--state",
				"open",
				"--limit",
				"50",
				"--json",
				"number,title,author,headRefName,isDraft,state,updatedAt",
			]).pipe(
				Effect.map((rows) =>
					rows
						.filter((r) => typeof r.number === "number")
						.map((r) =>
							GitPrSummary.make({
								number: r.number as number,
								title: r.title ?? "",
								author: r.author?.login ?? "",
								headRefName: r.headRefName ?? "",
								isDraft: r.isDraft === true,
								state: (r.state ?? "OPEN").toLowerCase(),
								updatedAt: new Date(r.updatedAt ?? 0),
							}),
						),
				),
			);

		const listIssues: GitService["Service"]["listIssues"] = (folderId) =>
			ghJsonList<{
				number?: number;
				title?: string;
				author?: { login?: string };
				state?: string;
				labels?: ReadonlyArray<{ name?: string }>;
				updatedAt?: string;
			}>(folderId, [
				"issue",
				"list",
				"--state",
				"open",
				"--limit",
				"50",
				"--json",
				"number,title,author,state,labels,updatedAt",
			]).pipe(
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
					const stdout = yield* ghRun(folderId, cwd, [
						"issue",
						"view",
						String(number),
						"--json",
						"number,title,body,author,url,labels,comments",
					]).pipe(
						Effect.catchTags({
							GitNotInstalledError: () => Effect.succeed(""),
							GitCommandError: () => Effect.succeed(""),
						}),
					);

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
						// renderer treats new files identically to modifications.
						const exists = yield* fs
							.exists(path.resolve(cwd, rel))
							.pipe(Effect.catch(() => Effect.succeed(false)));
						if (!exists) {
							return finish("unchanged", "");
						}
						const content = yield* fs
							.readFileString(path.resolve(cwd, rel))
							.pipe(
								Effect.catch((err) =>
									Effect.fail(
										new GitCommandError({
											folderId,
											reason: `read ${rel}: ${String(err)}`,
										}),
									),
								),
							);
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

		const reviewSummary: GitService["Service"]["reviewSummary"] = (
			folderId,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const range = yield* resolveReviewRange(folderId, cwd);
					const uncommitted = yield* changes(folderId, worktreeId);
					const names =
						range.baseSha.length === 0
							? []
							: parseReviewNames(
									yield* run(folderId, cwd, [
										"diff",
										"--name-status",
										"-z",
										"--find-renames",
										range.baseSha,
										"--",
									]),
								);
					const stats =
						range.baseSha.length === 0
							? new Map<string, ReviewStat>()
							: parseReviewStats(
									yield* run(folderId, cwd, [
										"diff",
										"--numstat",
										"-z",
										"--find-renames",
										range.baseSha,
										"--",
									]),
								);
					const pendingByPath = new Map<string, GitChange>();
					for (const change of uncommitted) {
						pendingByPath.set(change.path, change);
						if (change.oldPath !== null)
							pendingByPath.set(change.oldPath, change);
					}

					const files: GitReviewFile[] = names.map((entry) => {
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
							hasUncommittedChanges: pending !== undefined,
						});
					});
					const seen = new Set(
						files.flatMap((file) => [file.path, file.oldPath ?? ""]),
					);
					for (const pending of uncommitted) {
						if (pending.kind === "ignored" || seen.has(pending.path)) continue;
						let stat: ReviewStat = {
							additions: 0,
							deletions: 0,
							binary: false,
						};
						if (pending.kind === "untracked") {
							const contents = yield* fs
								.readFileString(path.resolve(cwd, pending.path))
								.pipe(Effect.catch(() => Effect.succeed("")));
							stat = {
								additions:
									contents.length === 0 ? 0 : contents.split("\n").length,
								deletions: 0,
								binary: contents.includes(NUL),
							};
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
						...range,
						files,
						additions: files.reduce((total, file) => total + file.additions, 0),
						deletions: files.reduce((total, file) => total + file.deletions, 0),
					});
				}),
			);

		const reviewPatches: GitService["Service"]["reviewPatches"] = (
			folderId,
			worktreeId,
		) =>
			Stream.unwrap(
				reviewSummary(folderId, worktreeId).pipe(
					Effect.map((summary) =>
						Stream.fromIterable(summary.files).pipe(
							Stream.mapEffect((file) =>
								(file.oldPath === null
									? diff(folderId, file.path, worktreeId)
									: Effect.flatMap(
											resolvePathForWorktree(folderId, worktreeId),
											(cwd) =>
												Effect.gen(function* () {
													const { baseSha } = yield* resolveReviewRange(
														folderId,
														cwd,
													);
													const patch = yield* run(folderId, cwd, [
														"diff",
														"--no-color",
														"--no-ext-diff",
														"--find-renames",
														baseSha,
														"--",
														file.oldPath ?? file.path,
														file.path,
													]);
													const maxBytes = 2_000_000;
													return GitDiffResult.make({
														mode: file.binary ? "binary" : "worktree",
														patch: patch.slice(0, maxBytes),
														truncated: patch.length > maxBytes,
														bytes: patch.length,
													});
												}),
										)
								).pipe(
									Effect.map((result) =>
										GitReviewPatch.make({ path: file.path, result }),
									),
								),
							),
						),
					),
				),
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

		/**
		 * Merge the current branch's PR directly via `gh pr merge` — no agent.
		 *   merge        → merge now with the chosen method
		 *   enable-auto  → arm GitHub-native auto-merge (`--auto`); GitHub merges
		 *                  once required checks pass. Needs the repo's "Allow
		 *                  auto-merge" setting; gh's error is surfaced verbatim.
		 *   disable-auto → cancel a queued auto-merge (`--disable-auto`).
		 * The combined stdout is returned so the renderer can surface gh's message.
		 */
		const mergePr: GitService["Service"]["mergePr"] = (
			folderId,
			action,
			method,
			deleteBranch,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const args: Array<string> = ["pr", "merge"];
					if (action === "disable-auto") {
						args.push("--disable-auto");
					} else {
						if (action === "enable-auto") args.push("--auto");
						args.push(`--${method}`);
						if (deleteBranch) args.push("--delete-branch");
					}
					const out = yield* ghRun(folderId, cwd, args);
					return { output: out };
				}),
			);

		/**
		 * Flip a draft PR to ready-for-review via `gh pr ready` — no agent.
		 */
		const markReady: GitService["Service"]["markReady"] = (
			folderId,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.map(ghRun(folderId, cwd, ["pr", "ready"]), (output) => ({
					output,
				})),
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
		 * Sum additions/deletions of the branch — including uncommitted edits —
		 * vs the merge-base with the repo's default branch. Binary files (`-`
		 * numstat columns) are skipped. Any git failure degrades to zeros so the
		 * sidebar never breaks on an odd repo state.
		 */
		const diffStat: GitService["Service"]["diffStat"] = (
			folderId,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const { baseSha } = yield* resolveReviewRange(folderId, cwd);
					if (baseSha.length === 0) return { additions: 0, deletions: 0 };
					const out = yield* run(folderId, cwd, ["diff", "--numstat", baseSha]);
					let additions = 0;
					let deletions = 0;
					for (const line of out.split("\n")) {
						const cols = line.split("\t");
						if (cols.length < 2) continue;
						const [added, deleted] = cols;
						if (added === undefined || deleted === undefined) continue;
						const a = Number.parseInt(added, 10);
						const d = Number.parseInt(deleted, 10);
						if (!Number.isNaN(a)) additions += a;
						if (!Number.isNaN(d)) deletions += d;
					}
					return { additions, deletions };
				}).pipe(
					Effect.catch(() => Effect.succeed({ additions: 0, deletions: 0 })),
				),
			);

		/**
		 * Capture logs from every failing GitHub Actions run on the current PR
		 * and drop them in `<worktree>/.zuse/failing-checks-<ts>.txt` so the
		 * renderer can attach the file to the composer (`@.zuse/...txt`) and
		 * ask the agent to fix it.
		 *
		 * Failing runs are detected via `gh pr view --json statusCheckRollup`;
		 * the run ID is parsed from each entry's `detailsUrl` (the
		 * `/actions/runs/<id>/...` segment). For each unique run we shell to
		 * `gh run view <id> --log-failed`, concatenate with a header, and write
		 * a single artifact.
		 */
		const fixFailingChecks: GitService["Service"]["fixFailingChecks"] = (
			folderId,
			worktreeId,
		) =>
			Effect.flatMap(resolvePathForWorktree(folderId, worktreeId), (cwd) =>
				Effect.gen(function* () {
					const stdout = yield* ghRun(folderId, cwd, [
						"pr",
						"view",
						"--json",
						"statusCheckRollup",
					]);

					type RollupEntry = {
						name?: string;
						status?: string;
						state?: string;
						conclusion?: string;
						detailsUrl?: string;
						targetUrl?: string;
					};
					let rollup: ReadonlyArray<RollupEntry> = [];
					try {
						const parsed = JSON.parse(stdout) as {
							statusCheckRollup?: ReadonlyArray<RollupEntry>;
						};
						rollup = parsed.statusCheckRollup ?? [];
					} catch {
						// fall through with empty rollup
					}

					const failing = rollup.filter((c) => {
						const conclusion = (c.conclusion ?? c.state ?? "").toUpperCase();
						return (
							conclusion === "FAILURE" ||
							conclusion === "CANCELLED" ||
							conclusion === "TIMED_OUT" ||
							conclusion === "ACTION_REQUIRED"
						);
					});

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
						const log = yield* ghRun(folderId, cwd, [
							"run",
							"view",
							id,
							"--log-failed",
						]).pipe(
							Effect.catchTag("GitCommandError", () =>
								Effect.succeed(`(failed to fetch logs for run ${id})\n`),
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

		// Per-subscription stream: a forked fiber polls HEAD every 2s and pushes
		// into a Queue only when the SHA changes. The fiber is scoped to the
		// stream's lifetime, so interrupting the renderer's subscription stops
		// the polling.
		const subscribeHeadChanges: GitService["Service"]["subscribeHeadChanges"] =
			(folderId) =>
				Stream.unwrap(
					Effect.gen(function* () {
						const mailbox = yield* Queue.make<
							{ readonly sha: string },
							GitFailure
						>();
						const lastSha = yield* Ref.make<string | null>(null);

						const tick = Effect.gen(function* () {
							const sha = yield* headSha(folderId);
							const prev = yield* Ref.get(lastSha);
							if (sha !== prev) {
								yield* Ref.set(lastSha, sha);
								Queue.offerUnsafe(mailbox, { sha });
							}
						});

						yield* Effect.forkScoped(
							Effect.repeat(tick, Schedule.spaced(Duration.seconds(2))).pipe(
								Effect.catch((err) =>
									Effect.sync(() =>
										Queue.failCauseUnsafe(mailbox, Cause.fail(err)),
									),
								),
							),
						);

						return Stream.fromQueue(mailbox);
					}),
				);

		return {
			log,
			status,
			branches,
			switchBranch,
			renameBranch,
			getUserName,
			subscribeHeadChanges,
			origin,
			prState,
			prDetails,
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
			resolveConflict,
			mergePr,
			markReady,
			init,
			revertFile,
			revertAll,
			restoreFileToBase,
			diffStat,
			fixFailingChecks,
		} as const;
	}),
);
