import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeFileSystem, NodePath, NodeServices } from "@effect/platform-node";
import { FolderId, GitFolderNotFoundError, WorktreeId } from "@zuse/contracts";
import {
	Effect,
	type FileSystem,
	Layer,
	type Path,
	PlatformError,
	Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { GitService } from "../../src/git-service.ts";
import { GitServiceLive } from "../../src/git-service-live.ts";
import { RepositoryLocator } from "../../src/repository-locator.ts";

const folderId = FolderId.make("repository-1");
const worktreeId = WorktreeId.make("worktree-1");

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("GitServiceLive", () => {
	let temporaryRoot = "";
	let repositoryRoot = "";

	beforeEach(() => {
		temporaryRoot = mkdtempSync(join(tmpdir(), "zuse-git-service-"));
		repositoryRoot = join(temporaryRoot, "repository");
		mkdirSync(repositoryRoot);
		git(repositoryRoot, "init", "--initial-branch=main");
		git(repositoryRoot, "config", "user.name", "Test User");
		git(repositoryRoot, "config", "user.email", "test@example.com");
		writeFileSync(join(repositoryRoot, "README.md"), "first\n");
		git(repositoryRoot, "add", "README.md");
		git(repositoryRoot, "commit", "-m", "initial commit");
	});

	afterEach(() => {
		rmSync(temporaryRoot, { recursive: true, force: true });
	});

	const makeLayer = ({
		root = repositoryRoot,
		worktreePath = null,
		platform = NodeServices.layer,
	}: {
		readonly root?: string;
		readonly worktreePath?: string | null;
		readonly platform?: Layer.Layer<
			| FileSystem.FileSystem
			| Path.Path
			| ChildProcessSpawner.ChildProcessSpawner
		>;
	} = {}) => {
		const LocatorLive = Layer.succeed(RepositoryLocator, {
			root: (requestedFolderId) =>
				requestedFolderId === folderId
					? Effect.succeed(root)
					: new GitFolderNotFoundError({ folderId: requestedFolderId }),
			worktreePath: (requestedWorktreeId) =>
				Effect.succeed(
					requestedWorktreeId === worktreeId ? worktreePath : null,
				),
			resolve: (requestedFolderId, requestedWorktreeId) =>
				requestedFolderId !== folderId
					? new GitFolderNotFoundError({ folderId: requestedFolderId })
					: Effect.succeed(
							requestedWorktreeId === worktreeId && worktreePath !== null
								? worktreePath
								: root,
						),
		});
		return GitServiceLive.pipe(
			Layer.provide(LocatorLive),
			Layer.provide(platform),
		);
	};

	const run = <A, E>(
		operation: (service: GitService["Service"]) => Effect.Effect<A, E>,
		layer = makeLayer(),
	) =>
		Effect.runPromise(
			Effect.flatMap(GitService, operation).pipe(Effect.provide(layer)),
		);

	test("reads log, status, branches, changes, and diffs from the repository", async () => {
		writeFileSync(join(repositoryRoot, "README.md"), "first\nsecond\n");
		writeFileSync(join(repositoryRoot, "new.txt"), "new\n");

		const [log, status, branches, changes, trackedDiff, untrackedDiff] =
			await run((service) =>
				Effect.all([
					service.log(folderId, 10),
					service.status(folderId),
					service.branches(folderId),
					service.changes(folderId),
					service.diff(folderId, "README.md"),
					service.diff(folderId, "new.txt"),
				]),
			);

		expect(log.map((entry) => entry.subject)).toEqual(["initial commit"]);
		expect(status).toMatchObject({ branch: "main", dirtyFiles: 2 });
		expect(branches).toEqual([
			expect.objectContaining({ name: "main", current: true, kind: "local" }),
		]);
		expect(changes.map((change) => change.path).sort()).toEqual([
			"README.md",
			"new.txt",
		]);
		expect(trackedDiff).toMatchObject({ mode: "worktree", truncated: false });
		expect(trackedDiff.patch).toContain("+second");
		expect(untrackedDiff).toMatchObject({
			mode: "untracked",
			truncated: false,
		});
		expect(untrackedDiff.patch).toContain("+++ b/new.txt");
	});

	test("commits changes and pushes the current branch", async () => {
		const remote = join(temporaryRoot, "remote.git");
		git(temporaryRoot, "init", "--bare", remote);
		git(repositoryRoot, "remote", "add", "origin", remote);
		writeFileSync(join(repositoryRoot, "README.md"), "committed\n");

		const commit = await run((service) =>
			service.commit(folderId, "update readme"),
		);
		await run((service) => service.push(folderId));

		expect(commit.sha).toBe(git(repositoryRoot, "rev-parse", "HEAD"));
		expect(git(remote, "rev-parse", "refs/heads/main")).toBe(commit.sha);
	});

	test("reviews committed, pushed, and uncommitted branch changes from the merge base", async () => {
		const remote = join(temporaryRoot, "remote.git");
		git(temporaryRoot, "init", "--bare", remote);
		git(repositoryRoot, "remote", "add", "origin", remote);
		git(repositoryRoot, "push", "-u", "origin", "main");
		git(repositoryRoot, "remote", "set-head", "origin", "main");
		git(repositoryRoot, "switch", "-c", "feature");
		writeFileSync(join(repositoryRoot, "README.md"), "first\ncommitted\n");
		writeFileSync(join(repositoryRoot, "branch.txt"), "branch\n");
		git(repositoryRoot, "add", ".");
		git(repositoryRoot, "commit", "-m", "branch work");
		git(repositoryRoot, "push", "-u", "origin", "feature");
		writeFileSync(
			join(repositoryRoot, "README.md"),
			"first\ncommitted\nuncommitted\n",
		);
		writeFileSync(join(repositoryRoot, "untracked.txt"), "new\n");

		const [summary, readmeDiff, streamed] = await run((service) =>
			Effect.all([
				service.reviewSummary(folderId),
				service.diff(folderId, "README.md"),
				Stream.runCollect(service.reviewPatches(folderId)),
			]),
		);

		expect(summary.baseRef).toBe("origin/main");
		expect(summary.files.map((file) => file.path)).toEqual([
			"branch.txt",
			"README.md",
			"untracked.txt",
		]);
		expect(
			summary.files.find((file) => file.path === "README.md"),
		).toMatchObject({ kind: "modified", hasUncommittedChanges: true });
		expect(readmeDiff.patch).toContain("+committed");
		expect(readmeDiff.patch).toContain("+uncommitted");
		expect(Array.from(streamed, (entry) => entry.path)).toEqual(
			summary.files.map((file) => file.path),
		);
	});

	test("restores a reviewed file to the comparison base as a worktree change", async () => {
		git(repositoryRoot, "switch", "-c", "feature");
		writeFileSync(join(repositoryRoot, "README.md"), "changed\n");
		git(repositoryRoot, "add", "README.md");
		git(repositoryRoot, "commit", "-m", "change readme");

		const result = await run((service) =>
			service.restoreFileToBase(folderId, "README.md"),
		);

		expect(result.restored).toBe(true);
		expect(git(repositoryRoot, "diff", "--", "README.md")).toContain("+first");
	});

	test("does not stage a conflict resolution while markers remain", async () => {
		const unresolved = [
			"<<<<<<< HEAD\n",
			"current\n",
			"=======\n",
			"incoming\n",
			">>>>>>> branch\n",
		].join("");
		writeFileSync(join(repositoryRoot, "README.md"), unresolved);

		await expect(
			run((service) =>
				service.resolveConflict(folderId, "README.md", unresolved),
			),
		).rejects.toMatchObject({
			_tag: "GitCommandError",
			folderId,
			reason: expect.stringContaining("markers remain"),
		});
		expect(readFileSync(join(repositoryRoot, "README.md"), "utf8")).toBe(
			unresolved,
		);
		expect(git(repositoryRoot, "diff", "--cached", "--name-only")).toBe("");
	});

	test("reports renamed, deleted, and binary files with review metadata", async () => {
		writeFileSync(join(repositoryRoot, "remove-me.txt"), "remove\n");
		git(repositoryRoot, "add", "remove-me.txt");
		git(repositoryRoot, "commit", "-m", "add fixture");
		git(repositoryRoot, "switch", "-c", "feature");
		git(repositoryRoot, "mv", "README.md", "README-renamed.md");
		git(repositoryRoot, "rm", "remove-me.txt");
		writeFileSync(join(repositoryRoot, "image.bin"), Buffer.from([0, 1, 2, 3]));
		git(repositoryRoot, "add", ".");

		const summary = await run((service) => service.reviewSummary(folderId));

		expect(summary.files).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: "README-renamed.md",
					oldPath: "README.md",
					kind: "renamed",
				}),
				expect.objectContaining({ path: "remove-me.txt", kind: "deleted" }),
				expect.objectContaining({ path: "image.bin", binary: true }),
			]),
		);
	});

	test("maps push failures to GitCommandError", async () => {
		await expect(
			run((service) => service.push(folderId)),
		).rejects.toMatchObject({ _tag: "GitCommandError", folderId });
	});

	test("maps a missing git executable to GitNotInstalledError", async () => {
		const MissingSpawnerLive = Layer.succeed(
			ChildProcessSpawner.ChildProcessSpawner,
			ChildProcessSpawner.make(() =>
				Effect.fail(
					new PlatformError.PlatformError(
						new PlatformError.SystemError({
							_tag: "NotFound",
							module: "test",
							method: "spawn",
						}),
					),
				),
			),
		);
		const PlatformLive = Layer.mergeAll(
			NodeFileSystem.layer,
			NodePath.layer,
			MissingSpawnerLive,
		);

		await expect(
			run(
				(service) => service.status(folderId),
				makeLayer({ platform: PlatformLive }),
			),
		).rejects.toMatchObject({ _tag: "GitNotInstalledError" });
	});

	test("uses the selected worktree path", async () => {
		const worktreeRoot = join(temporaryRoot, "worktree");
		git(repositoryRoot, "worktree", "add", "-b", "feature", worktreeRoot);

		const status = await run(
			(service) => service.status(folderId, worktreeId),
			makeLayer({ worktreePath: worktreeRoot }),
		);

		expect(status.branch).toBe("feature");
	});

	test("maps a non-repository folder to GitNotARepoError", async () => {
		const notRepository = join(temporaryRoot, "not-repository");
		mkdirSync(notRepository);

		await expect(
			run(
				(service) => service.status(folderId),
				makeLayer({ root: notRepository }),
			),
		).rejects.toMatchObject({ _tag: "GitNotARepoError", folderId });
	});

	test("preserves missing folder failures from the locator", async () => {
		const missingFolderId = FolderId.make("missing");
		await expect(
			run((service) => service.status(missingFolderId)),
		).rejects.toMatchObject({
			_tag: "GitFolderNotFoundError",
			folderId: missingFolderId,
		});
	});
});
